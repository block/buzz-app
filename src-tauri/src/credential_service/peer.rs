//! The executable on the other end of a loopback TCP connection, for the
//! pairing prompt to name. A TCP socket has no peer-credential option, so the
//! connection is found among the processes' open sockets by its two ports.
//! What it names is shown to the person, never trusted: the token a pairing
//! issues is bound by their approval, not by the process.
use std::path::PathBuf;

/// The executable of the process whose loopback socket on port `peer` is
/// connected to this app's port `local`, if it can be found.
pub(crate) fn executable(peer: u16, local: u16) -> Option<PathBuf> {
    imp::executable(peer, local)
}

#[cfg(target_os = "macos")]
mod imp {
    use std::ffi::c_void;
    use std::path::PathBuf;

    const PROC_PIDFDSOCKETINFO: i32 = 3;
    const SOCKINFO_TCP: i32 = 2;
    /// `struct socket_fdinfo` (`<sys/proc_info.h>`) is larger than this; only
    /// these offsets into it are read: `psi.soi_kind`, and the
    /// `insi_fport` and `insi_lport` that open its `soi_proto` union.
    const KIND: usize = 24 + 232;
    const FOREIGN_PORT: usize = 24 + 240;
    const LOCAL_PORT: usize = 24 + 244;
    const SOCKET_FDINFO: usize = 792;

    fn int(bytes: &[u8], at: usize) -> i32 {
        i32::from_ne_bytes(bytes[at..at + 4].try_into().unwrap_or_default())
    }
    /// A port as `in_sockinfo` holds it, in network order in an `int`.
    fn port(bytes: &[u8], at: usize) -> u16 {
        u16::from_be(int(bytes, at) as u16)
    }

    fn pids() -> Vec<i32> {
        // SAFETY: a null buffer asks only for the count.
        let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
        let mut pids = vec![0i32; count.max(0) as usize + 64];
        let bytes = (pids.len() * size_of::<i32>()) as i32;
        // SAFETY: the buffer holds `bytes` bytes.
        let found = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
        pids.truncate(found.max(0) as usize);
        pids
    }

    fn sockets(pid: i32) -> Vec<i32> {
        // SAFETY: a null buffer asks only for the size.
        let size =
            unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDLISTFDS, 0, std::ptr::null_mut(), 0) };
        if size <= 0 {
            return Vec::new();
        }
        let mut fds = vec![
            libc::proc_fdinfo {
                proc_fd: 0,
                proc_fdtype: 0
            };
            size as usize / size_of::<libc::proc_fdinfo>() + 16
        ];
        let bytes = (fds.len() * size_of::<libc::proc_fdinfo>()) as i32;
        // SAFETY: the buffer holds `bytes` bytes.
        let used = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDLISTFDS,
                0,
                fds.as_mut_ptr().cast(),
                bytes,
            )
        };
        fds.truncate(used.max(0) as usize / size_of::<libc::proc_fdinfo>());
        fds.into_iter()
            .filter(|fd| fd.proc_fdtype == libc::PROX_FDTYPE_SOCKET as u32)
            .map(|fd| fd.proc_fd)
            .collect()
    }

    fn connects(pid: i32, fd: i32, peer: u16, local: u16) -> bool {
        #[repr(C, align(8))]
        struct Info([u8; SOCKET_FDINFO]);
        let mut info = Info([0; SOCKET_FDINFO]);
        // SAFETY: the buffer holds `SOCKET_FDINFO` bytes, at least
        // `sizeof(struct socket_fdinfo)`.
        let read = unsafe {
            libc::proc_pidfdinfo(
                pid,
                fd,
                PROC_PIDFDSOCKETINFO,
                (&mut info as *mut Info).cast::<c_void>(),
                SOCKET_FDINFO as i32,
            )
        };
        let info = &info.0;
        read as usize > LOCAL_PORT + 4
            && int(info, KIND) == SOCKINFO_TCP
            && port(info, LOCAL_PORT) == peer
            && port(info, FOREIGN_PORT) == local
    }

    fn path(pid: i32) -> Option<PathBuf> {
        let mut buffer = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        // SAFETY: the buffer holds its length in bytes.
        let len =
            unsafe { libc::proc_pidpath(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
        (len > 0).then(|| {
            buffer.truncate(len as usize);
            PathBuf::from(String::from_utf8_lossy(&buffer).into_owned())
        })
    }

    pub(super) fn executable(peer: u16, local: u16) -> Option<PathBuf> {
        let pid = pids().into_iter().find(|&pid| {
            pid > 0
                && sockets(pid)
                    .into_iter()
                    .any(|fd| connects(pid, fd, peer, local))
        })?;
        path(pid)
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use std::path::PathBuf;

    /// The inode of the IPv4 TCP socket from port `peer` to port `local`.
    fn inode(peer: u16, local: u16) -> Option<String> {
        let table = std::fs::read_to_string("/proc/net/tcp").ok()?;
        let port = |address: &str| {
            address
                .rsplit_once(':')
                .and_then(|(_, port)| u16::from_str_radix(port, 16).ok())
        };
        table.lines().skip(1).find_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            (fields.len() > 9 && port(fields[1]) == Some(peer) && port(fields[2]) == Some(local))
                .then(|| fields[9].to_owned())
        })
    }

    pub(super) fn executable(peer: u16, local: u16) -> Option<PathBuf> {
        let socket = PathBuf::from(format!("socket:[{}]", inode(peer, local)?));
        std::fs::read_dir("/proc")
            .ok()?
            .flatten()
            .find_map(|process| {
                let holds = std::fs::read_dir(process.path().join("fd"))
                    .ok()?
                    .flatten()
                    .any(|fd| std::fs::read_link(fd.path()).is_ok_and(|link| link == socket));
                holds
                    .then(|| std::fs::read_link(process.path().join("exe")).ok())
                    .flatten()
            })
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
mod imp {
    pub(super) fn executable(_: u16, _: u16) -> Option<std::path::PathBuf> {
        None
    }
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod tests {
    /// A connection this process makes to itself is found, as this test's
    /// own executable.
    #[test]
    fn names_the_process_on_the_other_end() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let client = std::net::TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (_server, peer) = listener.accept().unwrap();
        let local = listener.local_addr().unwrap().port();
        assert_eq!(peer.port(), client.local_addr().unwrap().port());
        let found = super::executable(peer.port(), local).expect("the peer process");
        assert_eq!(
            found.canonicalize().unwrap(),
            std::env::current_exe().unwrap().canonicalize().unwrap()
        );
        // A port nothing connects from names nobody.
        assert_eq!(super::executable(peer.port(), local.wrapping_add(1)), None);
    }
}
