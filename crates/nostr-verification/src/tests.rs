use super::*;

fn corpus(count: usize, authors: usize) -> Vec<SignatureClaim> {
    let secp = Secp256k1::signing_only();
    (0..count)
        .map(|index| {
            let secret = Sha256::digest((index % authors).to_le_bytes());
            let key = secp256k1::Keypair::from_secret_key(
                &secp,
                &secp256k1::SecretKey::from_byte_array(secret.into()).unwrap(),
            );
            let id: [u8; 32] = Sha256::digest(index.to_le_bytes()).into();
            SignatureClaim {
                id: hex::encode(id),
                pubkey: key.x_only_public_key().0.to_string(),
                sig: secp.sign_schnorr_no_aux_rand(&id, &key).to_string(),
            }
        })
        .collect()
}

fn native(claims: &[SignatureClaim]) -> Vec<bool> {
    let secp = Secp256k1::verification_only();
    claims
        .iter()
        .map(|claim| {
            let (Ok(id), Ok(pubkey), Ok(sig)) = (
                nostr::event::EventId::from_hex(&claim.id),
                claim.pubkey.parse::<XOnlyPublicKey>(),
                claim.sig.parse::<Signature>(),
            ) else {
                return false;
            };
            secp.verify_schnorr(&sig, id.as_bytes(), &pubkey).is_ok()
        })
        .collect()
}

fn batch(claims: &[SignatureClaim]) -> bool {
    let decoded = claims
        .iter()
        .map(Decoded::from_wire)
        .collect::<Option<Vec<_>>>()
        .unwrap();
    batch_valid(&decoded)
}

#[test]
fn bip340_vectors_match_both_verifiers() {
    // Official bitcoin/bips bip-0340/test-vectors.csv, retrieved 2026-11-11.
    // BIP-340 code/vectors are BSD-2-Clause OR MIT OR CC0-1.0. Nostr signs
    // 32-byte IDs; valid signatures over other message lengths must be rejected.
    let mut tested = 0;
    let neighbors = corpus(24, 1);
    for row in include_str!("../tests/bip340.csv").lines().skip(1) {
        let fields: Vec<_> = row.splitn(8, ',').collect();
        let expected = fields[4].len() == 64 && fields[6] == "TRUE";
        let claim = SignatureClaim {
            id: fields[4].into(),
            pubkey: fields[2].into(),
            sig: fields[5].into(),
        };
        let claims = vec![claim.clone(); 12];
        assert!(should_batch(&claims));
        if fields[4].len() == 64 {
            assert_eq!(batch(&claims), expected, "batch vector {}", fields[0]);
        }
        assert_eq!(
            native(&claims),
            vec![expected; 12],
            "native vector {}",
            fields[0]
        );
        assert_eq!(verify(&claims), vec![expected; 12], "vector {}", fields[0]);
        let mut mixed = neighbors.clone();
        mixed[7] = claim;
        let mut verdicts = vec![true; mixed.len()];
        verdicts[7] = expected;
        assert!(should_batch(&mixed));
        assert_eq!(verify(&mixed), verdicts, "mixed vector {}", fields[0]);
        tested += 1;
    }
    assert_eq!(tested, 19);
}

#[test]
fn seeded_mutations_and_permutations_match_individual_verification() {
    let mut rng = ChaCha20Rng::seed_from_u64(0xb1_0340);
    let secp = Secp256k1::signing_only();
    // Exercise both sides of batch selection and the 512-claim chunk boundary.
    for (count, authors) in [
        (11, 1),
        (12, 1),
        (12, 2),
        (31, 3),
        (32, 4),
        (32, 5),
        (64, 8),
        (511, 4),
        (512, 4),
        (513, 4),
    ] {
        let keys: Vec<_> = (0..authors)
            .map(|_| {
                let mut secret = [0; 32];
                rng.fill_bytes(&mut secret);
                secp256k1::Keypair::from_secret_key(
                    &secp,
                    &secp256k1::SecretKey::from_byte_array(secret).unwrap(),
                )
            })
            .collect();
        let good: Vec<_> = (0..count)
            .map(|_| {
                let key = &keys[rng.next_u32() as usize % keys.len()];
                let mut id = [0; 32];
                rng.fill_bytes(&mut id);
                SignatureClaim {
                    id: hex::encode(id),
                    pubkey: key.x_only_public_key().0.to_string(),
                    sig: secp.sign_schnorr_no_aux_rand(&id, key).to_string(),
                }
            })
            .collect();
        assert_eq!(verify(&good), vec![true; count]);
        for field in 0..4 {
            let mut claims = good.clone();
            let index = rng.next_u32() as usize % count;
            let target = match field {
                0 => &mut claims[index].id,
                1 => &mut claims[index].pubkey,
                _ => &mut claims[index].sig,
            };
            if field == 3 {
                target.push('é');
            } else {
                let mut bytes = hex::decode(&*target).unwrap();
                let byte = rng.next_u32() as usize % bytes.len();
                bytes[byte] ^= 1 << (rng.next_u32() % 8);
                *target = hex::encode(bytes);
            }
            for i in (1..count).rev() {
                claims.swap(i, rng.next_u32() as usize % (i + 1));
            }
            let expected = native(&claims);
            assert_eq!(expected.iter().filter(|valid| !**valid).count(), 1);
            assert_eq!(
                verify(&claims),
                expected,
                "count={count}, authors={authors}, field={field}"
            );
        }
    }
}

#[test]
fn valid_batches_match_native_across_authors_and_chunk_boundaries() {
    assert!(verify(&[]).is_empty());
    for count in [1, 11, 12, 32, 128, 512, 513, 1031] {
        for authors in [1, 4, count] {
            let claims = corpus(count, authors);
            assert!(batch(&claims), "count={count}, authors={authors}");
            assert_eq!(verify(&claims), native(&claims));
            assert!(verify(&claims).iter().all(|valid| *valid));
        }
    }
}

#[test]
fn bad_signature_at_every_position_preserves_individual_results() {
    let good = corpus(32, 1);
    for index in 0..good.len() {
        let mut claims = good.clone();
        claims[index].id = "01".repeat(32);
        let mut expected = vec![true; good.len()];
        expected[index] = false;
        assert!(!batch(&claims));
        assert_eq!(native(&claims), expected);
        assert_eq!(verify(&claims), expected, "position {index}");
    }
}

#[test]
fn malformed_claims_and_invalid_chunk_do_not_poison_neighbors() {
    let mut claims = corpus(1031, 1);
    claims[0].id = "zz".repeat(32);
    claims[20].pubkey = "é".repeat(32);
    claims[511].sig.pop();
    claims[512].id = "00".repeat(32);
    claims[1000].sig = "ff".repeat(64);
    claims[1030].pubkey.clear();
    let mut expected = vec![true; claims.len()];
    for index in [0, 20, 511, 512, 1000, 1030] {
        expected[index] = false;
    }
    assert_eq!(verify(&claims), expected);
    assert_eq!(native(&claims), expected);
}

#[test]
fn weighted_batch_rejects_cancelling_signature_errors() {
    let mut claims = corpus(12, 1);
    // Keep R, message, and key unchanged, but offset two s values by +1/-1.
    // Their errors cancel under an unsafe unweighted aggregate equation.
    for (index, offset) in [(0, Scalar::ONE), (11, -Scalar::ONE)] {
        let mut sig = decode::<64>(&claims[index].sig).unwrap();
        let s = FieldBytes::try_from(&sig[32..]).unwrap();
        let changed = Scalar::from_repr(s).into_option().unwrap() + offset;
        sig[32..].copy_from_slice(&changed.to_bytes());
        claims[index].sig = hex::encode(sig);
    }
    assert!(!batch(&claims));
    let expected: Vec<_> = (0..12).map(|i| i != 0 && i != 11).collect();
    assert_eq!(native(&claims), expected);
    assert_eq!(verify(&claims), expected);
}

#[test]
fn signatures_must_be_bound_into_the_coefficient_seed() {
    let mut claims = corpus(12, 1);
    let decoded: Vec<_> = claims
        .iter()
        .map(|c| Decoded::from_wire(c).unwrap())
        .collect();
    // Model an unsafe verifier whose weights commit only to keys and messages.
    // An attacker can learn its last weight before choosing the forged scalars.
    let mut transcript = Sha256::new();
    for claim in &decoded {
        transcript.update(claim.pubkey);
    }
    for claim in &decoded {
        transcript.update(claim.id);
    }
    let mut rng = ChaCha20Rng::from_seed(transcript.finalize().into());
    let mut last = Scalar::ONE;
    for _ in 1..claims.len() {
        last = coefficient(&mut rng);
    }
    // Its weighted errors would cancel: 1 * last + last * (-1) == 0.
    for (index, offset) in [(0, last), (11, -Scalar::ONE)] {
        let mut sig = decode::<64>(&claims[index].sig).unwrap();
        let s = Scalar::from_repr(FieldBytes::try_from(&sig[32..]).unwrap())
            .into_option()
            .unwrap();
        sig[32..].copy_from_slice(&(s + offset).to_bytes());
        claims[index].sig = hex::encode(sig);
    }
    assert!(!batch(&claims));
    let expected: Vec<_> = (0..12).map(|i| i != 0 && i != 11).collect();
    assert_eq!(native(&claims), expected);
    assert_eq!(verify(&claims), expected);
}

#[test]
fn duplicates_and_different_signatures_over_the_same_id_are_checked() {
    let mut claims = vec![corpus(1, 1).remove(0); 12];
    assert!(batch(&claims));
    assert_eq!(verify(&claims), vec![true; 12]);
    claims[5].sig = "00".repeat(64);
    let expected: Vec<_> = (0..12).map(|i| i != 5).collect();
    assert_eq!(verify(&claims), expected);
}
