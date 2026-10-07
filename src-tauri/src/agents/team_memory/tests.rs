use super::*;
use serde_json::Value;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::Duration;

struct Request {
    path: String,
    headers: String,
    body: Vec<u8>,
}
struct Reply {
    status: u16,
    body: Vec<u8>,
}
fn json_reply(value: Value) -> Reply {
    Reply {
        status: 200,
        body: serde_json::to_vec(&value).unwrap(),
    }
}
// Loopback HTTP is test-only. Production destinations are canonical WSS -> HTTPS.
fn server(
    count: usize,
    mut reply: impl FnMut(usize, Request) -> Reply + Send + 'static,
) -> (String, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let worker = std::thread::spawn(move || {
        for index in 0..count {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let header_end = loop {
                let mut chunk = [0; 4096];
                let n = stream.read(&mut chunk).unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&chunk[..n]);
                if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    break end + 4;
                }
            };
            let headers = String::from_utf8(bytes[..header_end].to_vec()).unwrap();
            let length: usize = headers
                .lines()
                .find_map(|l| {
                    l.to_lowercase()
                        .strip_prefix("content-length: ")
                        .map(str::to_owned)
                })
                .unwrap()
                .trim()
                .parse()
                .unwrap();
            while bytes.len() < header_end + length {
                let mut chunk = [0; 4096];
                let n = stream.read(&mut chunk).unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&chunk[..n]);
            }
            let path = headers.split_whitespace().nth(1).unwrap().to_owned();
            let response = reply(
                index,
                Request {
                    path,
                    headers,
                    body: bytes[header_end..].to_vec(),
                },
            );
            let header = format!("HTTP/1.1 {} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", response.status, response.body.len());
            // A response-size refusal can close the client socket before all bytes arrive.
            let _ = stream
                .write_all(header.as_bytes())
                .and_then(|_| stream.write_all(&response.body));
        }
    });
    (origin, worker)
}

#[tokio::test]
async fn publication_requires_bounded_exact_receipt_and_retries_without_redirects() {
    let keys = Keys::generate();
    let event = EventBuilder::new(Kind::Custom(30174), "encrypted-fixture")
        .sign_with_keys(&keys)
        .unwrap();
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    for mode in [
        "refused",
        "redirect",
        "malformed",
        "oversized",
        "wrong-id",
        "rejected",
        "accepted",
    ] {
        let expected = event.id.to_hex();
        let pubkey = keys.public_key().to_hex();
        let (origin, worker) = server(1, move |_, request| {
            assert_eq!(request.path, "/events");
            let posted: Value = serde_json::from_slice(&request.body).unwrap();
            assert_eq!(posted["id"], expected);
            assert_eq!(posted["pubkey"], pubkey);
            let encoded = request
                .headers
                .lines()
                .find_map(|line| line.strip_prefix("authorization: Nostr "))
                .unwrap();
            let authorization: nostr_pairing::Event =
                serde_json::from_slice(&STANDARD.decode(encoded).unwrap()).unwrap();
            authorization.verify().unwrap();
            assert_eq!(authorization.pubkey.to_hex(), pubkey);
            let tags = serde_json::to_value(&authorization.tags).unwrap();
            assert!(tags
                .as_array()
                .unwrap()
                .contains(&json!(["method", "POST"])));
            assert!(tags.as_array().unwrap().contains(&json!([
                "payload",
                format!("{:x}", <Sha256 as sha2::Digest>::digest(&request.body))
            ])));
            assert!(request
                .headers
                .contains("x-auth-tag: fixture-authorization"));
            match mode {
                "refused" => Reply {
                    status: 403,
                    body: vec![],
                },
                "redirect" => Reply {
                    status: 302,
                    body: vec![],
                },
                "malformed" => Reply {
                    status: 200,
                    body: b"invalid".to_vec(),
                },
                "oversized" => Reply {
                    status: 200,
                    body: vec![b' '; 16 * 1024 + 1],
                },
                _ => json_reply(json!({"accepted":mode!="rejected",
                    "event_id":if mode=="wrong-id" { "00".repeat(32) } else { expected.clone() }})),
            }
        });
        let outcome = publish_memory(
            &client,
            &format!("{origin}/events"),
            "fixture-authorization",
            &keys,
            &event,
        )
        .await;
        assert_eq!(outcome.is_ok(), mode == "accepted", "{mode}: {outcome:?}");
        worker.join().unwrap();
    }
}

#[test]
fn accepted_receipt_is_not_current_confirmation() {
    let current = json!({"partial":false,"entries":[{"slug":"core","eventId":"saved"}]});
    confirm_current(&current, "core", "saved").unwrap();
    for listing in [
        json!({"partial":true,"entries":[{"slug":"core","eventId":"saved"}]}),
        json!({"entries":[{"slug":"core","eventId":"saved"}]}),
        json!({"partial":false,"entries":[]}),
        json!({"partial":false,"entries":[{"slug":"core","eventId":"newer"}]}),
        json!({"partial":false,"entries":[{"slug":"mem/other","eventId":"saved"}]}),
    ] {
        assert!(confirm_current(&listing, "core", "saved").is_err());
    }
}
