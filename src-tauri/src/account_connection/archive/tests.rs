use super::*;
fn raw(time: i64, id: &str) -> String {
    serde_json::json!({"created_at":time,"content":"encrypted-only","id":id}).to_string()
}
#[test]
fn original_ciphertext_dedup_restart_partition_and_delete_cutoff() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("archive");
    let store = Archive::new(path.clone());
    let data = raw(10, "one");
    store
        .append(
            ("viewer", "origin"),
            "one",
            "agent",
            &data,
            &["c".into()],
            10_000,
        )
        .unwrap();
    store
        .append(
            ("viewer", "origin"),
            "one",
            "agent",
            &data,
            &["c".into()],
            99_000,
        )
        .unwrap();
    let page = store
        .page("viewer", "origin", "agent", Some("c"), None, 99_000)
        .unwrap();
    assert_eq!(page.rows.len(), 1);
    assert_eq!(page.rows[0].received_at, 10_000);
    assert_eq!(page.rows[0].raw, data);
    assert!(store
        .page("other", "origin", "agent", None, None, 99_000)
        .unwrap()
        .rows
        .is_empty());
    drop(store);
    let store = Archive::new(path);
    assert_eq!(
        store
            .page("viewer", "origin", "agent", Some("c"), None, 100_000)
            .unwrap()
            .rows
            .len(),
        1
    );
    store.delete("viewer", "origin", 100_000).unwrap();
    store
        .append(
            ("viewer", "origin"),
            "one",
            "agent",
            &data,
            &["c".into()],
            101_000,
        )
        .unwrap_err();
    assert!(store
        .page("viewer", "origin", "agent", None, None, 101_000)
        .unwrap()
        .rows
        .is_empty());
    store
        .append(
            ("viewer", "origin"),
            "new",
            "agent",
            &raw(401, "new"),
            &["c".into()],
            401_000,
        )
        .unwrap();
    assert_eq!(
        store
            .page("viewer", "origin", "agent", None, None, 401_000)
            .unwrap()
            .rows
            .len(),
        1
    );
}
#[test]
fn paging_age_and_whole_mixed_envelope_purge() {
    let dir = tempfile::tempdir().unwrap();
    let store = Archive::new(dir.path().join("archive"));
    for i in 0..105 {
        store
            .append(
                ("v", "o"),
                &format!("{i}"),
                "a",
                &raw(i, &format!("{i}")),
                &["one".into(), "two".into()],
                i * 1000,
            )
            .unwrap();
    }
    let page = store
        .page("v", "o", "a", Some("one"), None, 105_000)
        .unwrap();
    assert_eq!(page.rows.len(), 100);
    assert!(page.more);
    let rest = store
        .page(
            "v",
            "o",
            "a",
            Some("one"),
            Some(page.rows.last().unwrap().sequence),
            105_000,
        )
        .unwrap();
    assert_eq!(rest.rows.len(), 5);
    assert!(!rest.more);
    store.purge_channel("v", "o", "two").unwrap();
    let page = store
        .page("v", "o", "a", Some("one"), None, 105_000)
        .unwrap();
    assert!(page.rows.is_empty());
    assert!(page.trimmed);
    store
        .append(
            ("v", "o"),
            "expired",
            "a",
            &raw(0, "expired"),
            &["one".into()],
            0,
        )
        .unwrap();
    assert!(store
        .page("v", "o", "a", None, None, AGE_MS + 1)
        .unwrap()
        .rows
        .is_empty());
}
#[test]
fn corrupt_or_symlink_store_fails_without_overwrite() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("archive");
    std::fs::create_dir(&root).unwrap();
    let path = root.join("activity.sqlite");
    std::fs::write(&path, b"corrupt").unwrap();
    let store = Archive::new(root.clone());
    assert!(store.page("v", "o", "a", None, None, 0).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), b"corrupt");
    #[cfg(unix)]
    {
        std::fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(dir.path().join("elsewhere"), &path).unwrap();
        assert!(Archive::new(root)
            .page("v", "o", "a", None, None, 0)
            .is_err());
    }
}
#[test]
fn capacity_and_physical_limit_configuration_are_global() {
    let dir = tempfile::tempdir().unwrap();
    let store = Archive::new(dir.path().join("archive"));
    store.with(|db|{let tx=db.transaction().unwrap();for i in 0..20_001{tx.execute("INSERT INTO frames(viewer,origin,id,agent,received,bytes,raw) VALUES(?,?,?,?,?,?,?)",params![if i%2==0{"v1"}else{"v2"},"o",i.to_string(),"a",0,10,"encrypted"]).unwrap();}tx.commit().unwrap();prune(db,0)?;
 let count:i64=db.query_row("SELECT count(*) FROM frames",[],|r|r.get(0)).unwrap();assert_eq!(count,20_000);
 let pages:i64=db.query_row("PRAGMA max_page_count",[],|r|r.get(0)).unwrap();assert_eq!(pages,30720);
 let mode:String=db.query_row("PRAGMA journal_mode",[],|r|r.get(0)).unwrap();assert_eq!(mode,"delete");Ok(())}).unwrap();
}

#[test]
fn physical_capacity_evicts_and_recovers_before_insert_failure() {
    let dir = tempfile::tempdir().unwrap();
    let store = Archive::new(dir.path().join("archive"));
    store
        .with(|db| {
            db.execute_batch("PRAGMA max_page_count=96").unwrap();
            Ok(())
        })
        .unwrap();
    for i in 0..30 {
        let raw = serde_json::json!({"created_at":i,"content":"x".repeat(40_000)}).to_string();
        store
            .append(
                ("v", "o"),
                &i.to_string(),
                "a",
                &raw,
                &["c".into()],
                i * 1000,
            )
            .unwrap();
    }
    let page = store.page("v", "o", "a", Some("c"), None, 30_000).unwrap();
    assert!(page.trimmed);
    assert!(!page.rows.is_empty());
    assert!(page.rows.len() < 30);
    assert_eq!(page.rows[0].id, "29");
}

#[test]
fn age_expiry_does_not_assume_receipt_clock_monotonicity() {
    let dir = tempfile::tempdir().unwrap();
    let store = Archive::new(dir.path().join("archive"));
    store
        .append(
            ("v", "o"),
            "first",
            "a",
            &raw(1, "first"),
            &["c".into()],
            AGE_MS,
        )
        .unwrap();
    store
        .append(
            ("v", "o"),
            "rollback",
            "a",
            &raw(1, "rollback"),
            &["c".into()],
            0,
        )
        .unwrap();
    let page = store.page("v", "o", "a", None, None, AGE_MS + 1).unwrap();
    assert_eq!(page.rows.len(), 1);
    assert_eq!(page.rows[0].id, "first");
    assert!(page.trimmed);
}
