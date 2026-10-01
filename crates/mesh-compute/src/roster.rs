//! Membership-change confirmation, independent of node restart and request admission.
//! Two consecutive successful observations are required; read failures reset confirmation.

#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    Keep,
    AwaitConfirmation,
    Grow(Vec<String>),
    Shrink(Vec<String>),
    ViewerRemoved,
}

/// Verified query outcome. Transport failure must never masquerade as removal.
pub enum Observation {
    Members(Vec<String>),
    ReadFailed,
    ViewerRemoved,
}

/// One instance belongs to one runtime generation; discard it on replacement.
#[derive(Default)]
pub struct Reconcile {
    pending: Option<Vec<String>>,
}

impl Reconcile {
    /// Compare verified owner sets. Startup defers changes, except verified viewer removal.
    pub fn observe(
        &mut self,
        current: &[String],
        observation: Observation,
        starting: bool,
    ) -> Decision {
        let mut fresh = match observation {
            Observation::ViewerRemoved => {
                self.pending = None;
                return Decision::ViewerRemoved;
            }
            Observation::ReadFailed => {
                self.pending = None;
                return Decision::Keep;
            }
            Observation::Members(owners) => owners,
        };
        fresh.sort();
        fresh.dedup();
        let mut current = current.to_vec();
        current.sort();
        current.dedup();
        if starting || fresh == current {
            self.pending = None;
            return Decision::Keep;
        }
        if self.pending.as_ref() != Some(&fresh) {
            self.pending = Some(fresh);
            return Decision::AwaitConfirmation;
        }
        self.pending = None;
        if current.iter().any(|owner| !fresh.contains(owner)) {
            Decision::Shrink(fresh)
        } else {
            Decision::Grow(fresh)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn members(values: &[&str]) -> Observation {
        Observation::Members(values.iter().map(|s| (*s).into()).collect())
    }
    #[test]
    fn growth_and_shrink_require_consecutive_matching_successes() {
        let current = vec!["a".into()];
        let mut state = Reconcile::default();
        assert_eq!(
            state.observe(&current, members(&["b", "a", "a"]), false),
            Decision::AwaitConfirmation
        );
        assert_eq!(
            state.observe(&current, Observation::ReadFailed, false),
            Decision::Keep
        );
        assert_eq!(
            state.observe(&current, members(&["a", "b"]), false),
            Decision::AwaitConfirmation
        );
        assert_eq!(
            state.observe(&current, members(&["b", "a"]), false),
            Decision::Grow(vec!["a".into(), "b".into()])
        );
        assert_eq!(
            state.observe(&current, members(&[]), false),
            Decision::AwaitConfirmation
        );
        assert_eq!(
            state.observe(&current, members(&[]), false),
            Decision::Shrink(vec![])
        );
    }
    #[test]
    fn recovery_changed_candidate_and_startup_reset_confirmation() {
        let current = vec!["a".into(), "b".into()];
        let mut state = Reconcile::default();
        assert_eq!(
            state.observe(&current, members(&["a"]), false),
            Decision::AwaitConfirmation
        );
        assert_eq!(
            state.observe(&current, members(&["b"]), false),
            Decision::AwaitConfirmation
        );
        assert_eq!(
            state.observe(&current, members(&["a", "b"]), false),
            Decision::Keep
        );
        assert_eq!(
            state.observe(&current, members(&["b"]), false),
            Decision::AwaitConfirmation
        );
        assert_eq!(
            state.observe(&current, members(&["b"]), true),
            Decision::Keep
        );
        assert_eq!(
            state.observe(&current, members(&["b"]), false),
            Decision::AwaitConfirmation
        );
        assert_eq!(
            state.observe(&current, Observation::ViewerRemoved, true),
            Decision::ViewerRemoved
        );
    }
}
