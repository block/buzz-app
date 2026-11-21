//! Portable: the predicate is pure, so these run on every platform. They judge
//! reported observations only; reading a real scope is not exercised here.
use super::*;
use std::ffi::OsString;

const V1: &str = r#"{"version":1,"bundledEnabled":true,"installed":{}}"#;
const V2: &str = r#"{"version":2,"bundledEnabled":false,"bundledOverrides":{"buzz.feedback":false},"installed":{}}"#;
const HASH: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const UUID: &str = "6f1c1a3e-1b2c-4d5e-8f90-123456789abc";

/// A version 2 registry with one installed plugin; `extra` joins its entry.
fn installed(id: &str, manifest_id: &str, current: &str, extra: &str) -> String {
    format!(
        r#"{{"version":2,"bundledEnabled":true,"installed":{{"{id}":{{"manifest":{{"id":"{manifest_id}","name":"Example","apiVersion":1}},"current":"{current}","previous":null,"enabled":true{extra}}}}}}}"#
    )
}
fn scope() -> Scope {
    Scope {
        inventories: vec![
            "/data/plugin-secrets".into(),
            "/data/plugin-secrets.debug".into(),
        ],
        homes: vec!["/data/app".into(), "/data/env-home".into()],
    }
}
fn names(count: usize) -> Vec<OsString> {
    (0..count).map(|i| format!("profile-{i}").into()).collect()
}
/// Both inventories absent, the first home listing `profiles`, the second
/// home holding no `profiles` folder.
fn complete<'a>(
    scope: &'a Scope,
    profiles: &'a [(OsString, Option<&'a [u8]>)],
) -> Vec<Observation<'a>> {
    let mut seen = vec![
        Observation::InventoryAbsent(&scope.inventories[0]),
        Observation::InventoryAbsent(&scope.inventories[1]),
        Observation::Profiles(&scope.homes[0]),
    ];
    seen.extend(
        profiles
            .iter()
            .map(|(name, registry)| Observation::Profile {
                name,
                registry: *registry,
            }),
    );
    seen.extend([Observation::End, Observation::NoProfiles(&scope.homes[1])]);
    seen
}
fn judge(scope: &Scope, seen: &[Observation]) -> Result<NoH1EvidenceFound> {
    let mut inspection = Inspection::new(scope);
    for observation in seen {
        inspection.observe(*observation);
    }
    inspection.conclude()
}
/// The verdict on one profile holding `registry`.
fn registry(bytes: &[u8]) -> Result<NoH1EvidenceFound> {
    let scope = scope();
    judge(
        &scope,
        &complete(&scope, &[("default".into(), Some(bytes))]),
    )
}

#[test]
fn the_affirmation_says_exactly_what_it_found() {
    assert_eq!(
        NoH1EvidenceFound::MEANING,
        "No H1 evidence found in the completely inspected, declared scope."
    );
}

#[test]
fn legacy_profiles_well_past_the_namespace_limit_up_to_the_bound_find_no_evidence() {
    let scope = scope();
    let plugin = installed("example.slots", "example.slots", HASH, "");
    for count in [0, crate::secrets::MAX_NAMESPACES + 1, MAX_PROFILES] {
        // Every kind of entry counts: no registry, version 1, version 2.
        let profiles: Vec<_> = names(count)
            .into_iter()
            .enumerate()
            .map(|(i, name)| {
                let registry = [None, Some(V1.as_bytes()), Some(V2.as_bytes())][i % 3];
                (name, registry.or((i % 7 == 1).then_some(plugin.as_bytes())))
            })
            .collect();
        assert_eq!(
            judge(&scope, &complete(&scope, &profiles)),
            Ok(NoH1EvidenceFound(())),
            "{count} profiles"
        );
    }
}

#[test]
fn one_entry_past_the_bound_refuses_whatever_the_entries_hold() {
    let scope = scope();
    for registry in [None, Some(V2.as_bytes())] {
        let profiles: Vec<_> = names(MAX_PROFILES + 1)
            .into_iter()
            .map(|name| (name, registry))
            .collect();
        assert_eq!(
            judge(&scope, &complete(&scope, &profiles)),
            Err(TOO_MANY.into())
        );
    }
    // Counted per listing: each home may hold the bound.
    let full: Vec<_> = names(MAX_PROFILES).into_iter().map(|n| (n, None)).collect();
    let mut seen = complete(&scope, &full);
    seen.pop();
    seen.push(Observation::Profiles(&scope.homes[1]));
    seen.extend(full.iter().map(|(name, _)| Observation::Profile {
        name,
        registry: None,
    }));
    seen.push(Observation::End);
    assert_eq!(judge(&scope, &seen), Ok(NoH1EvidenceFound(())));
}

#[test]
fn registries_at_the_size_limit_pass_and_one_byte_more_refuses() {
    let mut bytes = V2.as_bytes().to_vec();
    bytes.resize(LIMIT as usize, b' ');
    assert_eq!(registry(&bytes), Ok(NoH1EvidenceFound(())));
    bytes.push(b' ');
    assert_eq!(registry(&bytes), Err(UNREADABLE.into()));
}

#[test]
fn saved_credential_state_refuses_from_this_or_another_build() {
    for variant in ["debug", "release"] {
        let v3 = format!(
            r#"{{"version":3,"bundledEnabled":true,"installed":{{}},"secrets":{{"lineage":"{UUID}","variant":"{variant}"}}}}"#
        );
        let refused = registry(v3.as_bytes());
        let reason = if variant == crate::secrets::VARIANT {
            EVIDENCE
        } else {
            UNREADABLE
        };
        assert_eq!(refused, Err(reason.into()), "{variant}");
    }
}

#[test]
fn corrupt_unsupported_or_invalid_registries_refuse() {
    let lineage = format!(r#","secrets":{{"lineage":"{UUID}","variant":"debug"}}"#);
    let cases = [
        "".to_owned(),
        "{".into(),
        "null".into(),
        V2.replace("\"version\":2", "\"version\":0"),
        V2.replace("\"version\":2", "\"version\":4"),
        V2.replace("\"installed\":{}", "\"installed\":{},\"later\":true"),
        // Lineage or a generation inside a version 1 or 2 registry.
        V2.replace("\"installed\":{}", &format!("\"installed\":{{}}{lineage}")),
        V1.replace("\"installed\":{}", &format!("\"installed\":{{}}{lineage}")),
        installed(
            "example.slots",
            "example.slots",
            HASH,
            &format!(r#","generation":"{UUID}""#),
        ),
        installed("example.slots", "example.slots", HASH, r#","later":true"#),
        installed("example.slots", "example.other", HASH, ""),
        installed("example.slots", "example.slots", "not-a-hash", ""),
        installed("buzz.channels", "buzz.channels", HASH, ""),
        installed("example.slots", "example.slots", HASH, "")
            .replace(r#""apiVersion":1"#, r#""apiVersion":1,"later":true"#),
        installed("Example", "Example", HASH, ""),
    ];
    for case in &cases {
        assert_eq!(registry(case.as_bytes()), Err(UNREADABLE.into()), "{case}");
    }
    assert_eq!(registry(&[0xff, 0xfe]), Err(UNREADABLE.into()));
}

/// Preserve repeated map keys in the JSON text; a Value/BTreeMap fixture
/// would collapse exactly the input this regression needs to inspect.
fn duplicate_installed(first: &str, second: &str) -> String {
    let member = |registry: &str| {
        registry
            .strip_prefix(r#"{"version":2,"bundledEnabled":true,"installed":{"#)
            .unwrap()
            .strip_suffix("}}")
            .unwrap()
            .to_owned()
    };
    format!(
        r#"{{"version":2,"bundledEnabled":true,"installed":{{{},{}}}}}"#,
        member(first),
        member(second)
    )
}
fn duplicate_orders_refuse(other: &str) {
    let valid = installed("example.slots", "example.slots", HASH, "");
    let outcomes: Vec<_> = [(&valid[..], other), (other, &valid[..])]
        .into_iter()
        .map(|(first, second)| registry(duplicate_installed(first, second).as_bytes()))
        .collect();
    assert_eq!(
        outcomes,
        vec![Err(UNREADABLE.into()), Err(UNREADABLE.into())]
    );
}

#[test]
fn duplicate_installed_keys_with_a_generation_refuse_in_both_orders() {
    duplicate_orders_refuse(&installed(
        "example.slots",
        "example.slots",
        HASH,
        &format!(r#", "generation":"{UUID}""#),
    ));
}

#[test]
fn duplicate_installed_keys_with_a_corrupt_entry_refuse_in_both_orders() {
    duplicate_orders_refuse(&installed("example.slots", "example.other", "bad-hash", ""));
}

fn malformed_former_installed_refuses(id: &str) {
    let cases = [
        installed(id, id, "bad-hash", ""),
        installed(id, "example.other", HASH, ""),
        installed(id, id, HASH, r#", "previous":"bad-hash""#).replace(r#""previous":null,"#, ""),
    ];
    let outcomes: Vec<_> = cases.iter().map(|text| registry(text.as_bytes())).collect();
    assert_eq!(
        outcomes,
        cases
            .iter()
            .map(|_| Err(UNREADABLE.into()))
            .collect::<Vec<_>>()
    );
}

#[test]
fn malformed_former_installed_claude_code_refuses_before_normalization() {
    malformed_former_installed_refuses("buzz.claude-code");
}

#[test]
fn malformed_former_installed_codex_refuses_before_normalization() {
    malformed_former_installed_refuses("buzz.codex");
}

#[test]
fn valid_former_installed_entries_keep_legacy_compatibility() {
    for id in crate::FORMERLY_INSTALLED {
        for enabled in [true, false] {
            for version in [1, 2] {
                let text = installed(id, id, HASH, "")
                    .replace(r#""enabled":true"#, &format!(r#""enabled":{enabled}"#))
                    .replace(r#""version":2"#, &format!(r#""version":{version}"#));
                assert_eq!(registry(text.as_bytes()), Ok(NoH1EvidenceFound(())));
            }
        }
    }
}

#[test]
fn duplicate_struct_fields_still_refuse() {
    let entry = installed("example.slots", "example.slots", HASH, "");
    let cases = [
        V2.replace(r#""version":2"#, r#""version":2,"version":2"#),
        V2.replace(r#""installed":{}"#, r#""installed":{},"installed":{}"#),
        entry.replace(r#""enabled":true"#, r#""enabled":true,"enabled":true"#),
        entry.replace(r#""apiVersion":1"#, r#""apiVersion":1,"apiVersion":1"#),
    ];
    for text in cases {
        assert_eq!(registry(text.as_bytes()), Err(UNREADABLE.into()));
    }
}

#[test]
fn entries_that_are_not_valid_profiles_refuse() {
    let scope = scope();
    for name in [
        "",
        "../default",
        "Default",
        "has space",
        ".DS_Store",
        "a..b",
    ] {
        let profiles = [(OsString::from(name), None)];
        assert_eq!(
            judge(&scope, &complete(&scope, &profiles)),
            Err(UNRESOLVED.into()),
            "{name:?}"
        );
    }
}

#[test]
#[cfg(any(unix, windows))]
fn a_profile_name_that_is_not_unicode_refuses() {
    #[cfg(unix)]
    let name = {
        use std::os::unix::ffi::OsStringExt;
        OsString::from_vec(b"default\xff".to_vec())
    };
    #[cfg(windows)]
    let name = {
        use std::os::windows::ffi::OsStringExt;
        // An unpaired surrogate.
        OsString::from_wide(&[0x64, 0xd800])
    };
    assert!(name.to_str().is_none());
    let scope = scope();
    let profiles = [(name, None)];
    assert_eq!(
        judge(&scope, &complete(&scope, &profiles)),
        Err(UNRESOLVED.into())
    );
}

#[test]
fn an_unresolved_location_anywhere_refuses_and_stays_refused() {
    let scope = scope();
    let profiles = [("default".into(), Some(V2.as_bytes()))];
    let seen = complete(&scope, &profiles);
    for at in 0..=seen.len() {
        let mut unresolved = seen.clone();
        unresolved.insert(at, Observation::Unresolved);
        assert_eq!(judge(&scope, &unresolved), Err(UNRESOLVED.into()), "{at}");
    }
    // The first refusal is final, whatever follows.
    let corrupt = [("default".into(), Some(&b"{"[..]))];
    let mut seen = complete(&scope, &corrupt);
    seen.insert(4, Observation::Unresolved);
    assert_eq!(judge(&scope, &seen), Err(UNREADABLE.into()));
}

#[test]
fn a_truncated_inspection_is_incomplete_never_absence() {
    let scope = scope();
    let profiles = [("default".into(), None)];
    let seen = complete(&scope, &profiles);
    for len in 0..seen.len() {
        assert_eq!(judge(&scope, &seen[..len]), Err(INCOMPLETE.into()), "{len}");
    }
    // Nothing declared to inspect is nothing inspected.
    for scope in [
        Scope {
            inventories: Vec::new(),
            ..scope.clone()
        },
        Scope {
            homes: Vec::new(),
            ..scope.clone()
        },
    ] {
        let seen: Vec<_> = (scope.inventories.iter())
            .map(|root| Observation::InventoryAbsent(root))
            .chain(scope.homes.iter().map(|home| Observation::NoProfiles(home)))
            .collect();
        assert_eq!(judge(&scope, &seen), Err(INCOMPLETE.into()));
    }
}

#[test]
fn unexpected_repeated_or_unordered_locations_refuse() {
    let scope = scope();
    let elsewhere = PathBuf::from("/data/elsewhere");
    let profile = Observation::Profile {
        name: OsStr::new("default"),
        registry: None,
    };
    let [first, second] = [&scope.inventories[0], &scope.inventories[1]];
    let [app, env] = [&scope.homes[0], &scope.homes[1]];
    use Observation::*;
    let cases: [&[Observation]; 9] = [
        // An undeclared home, or a home reported as an inventory.
        &[
            InventoryAbsent(first),
            InventoryAbsent(second),
            NoProfiles(&elsewhere),
        ],
        &[
            InventoryAbsent(first),
            InventoryAbsent(second),
            InventoryAbsent(app),
        ],
        // Homes before the inventories, or out of order.
        &[
            NoProfiles(app),
            NoProfiles(env),
            InventoryAbsent(first),
            InventoryAbsent(second),
        ],
        &[
            InventoryAbsent(second),
            InventoryAbsent(first),
            NoProfiles(app),
            NoProfiles(env),
        ],
        // A location reported twice, or after the scope ends.
        &[
            InventoryAbsent(first),
            InventoryAbsent(first),
            InventoryAbsent(second),
        ],
        &[
            InventoryAbsent(first),
            InventoryAbsent(second),
            NoProfiles(app),
            NoProfiles(env),
            NoProfiles(env),
        ],
        // An entry outside a listing, a listing ended twice, or a location inside one.
        &[InventoryAbsent(first), InventoryAbsent(second), profile],
        &[
            InventoryAbsent(first),
            InventoryAbsent(second),
            Profiles(app),
            End,
            End,
        ],
        &[
            InventoryAbsent(first),
            InventoryAbsent(second),
            Profiles(app),
            NoProfiles(env),
        ],
    ];
    for seen in cases {
        assert_eq!(judge(&scope, seen), Err(OUT_OF_SCOPE.into()), "{seen:?}");
    }
}

#[test]
fn judging_changes_neither_the_scope_nor_what_was_read() {
    let scope = scope();
    let declared = scope.clone();
    let bytes = V2.as_bytes().to_vec();
    let profiles = [("default".into(), Some(bytes.as_slice()))];
    assert!(judge(&scope, &complete(&scope, &profiles)).is_ok());
    assert_eq!((scope, bytes), (declared, V2.as_bytes().to_vec()));
}
