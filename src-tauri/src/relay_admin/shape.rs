//! Success shapes per route, mirroring beta's admin DTOs (`contract.ts`
//! `StaffResults`). A 2xx is only a success if its body has the shape that
//! route's handler returns; extra fields are tolerated, missing or unknown
//! values are not.

#![allow(dead_code)] // Fields exist to be checked, not read.

use super::route::StaffRequest;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Role {
    Operator,
    Moderator,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Source {
    Config,
    OwnerFallback,
    Db,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum AuthMode {
    Nip98,
    Disabled,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Probe {
    status: String,
    auth_mode: AuthMode,
    role: Option<Role>,
    source: Option<Source>,
    can_act: bool,
    can_staff: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Action {
    Delete,
    Kick,
    Ban,
    Timeout,
    Dismiss,
    Escalate,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum ActionStatus {
    Pending,
    Enforcing,
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActionRecord {
    id: String,
    request_id: String,
    actor_pubkey: String,
    actor_role: Role,
    action: Action,
    status: ActionStatus,
    created_at: String,
    updated_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum ReportStatus {
    Open,
    Processing,
    Resolved,
    Dismissed,
    Escalated,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    id: String,
    community_id: String,
    community_host: String,
    report_event_id: String,
    reporter_pubkey: String,
    target_kind: String,
    target: String,
    report_type: String,
    status: ReportStatus,
    active_action: Option<ActionRecord>,
    created_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Resolution {
    status: String,
    active_action: Option<ActionRecord>,
}

#[derive(Deserialize)]
struct Status {
    status: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum FeedbackStatus {
    New,
    Reviewed,
    Archived,
}

#[derive(Deserialize)]
struct FeedbackState {
    status: FeedbackStatus,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FeedbackSummary {
    id: String,
    submitter_pubkey: String,
    body_summary: String,
    status: FeedbackStatus,
    received_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Feedback {
    id: String,
    event_id: String,
    submitter_pubkey: String,
    body: String,
    status: FeedbackStatus,
    event_created_at: String,
    received_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Operator {
    pubkey: String,
    effective_role: Role,
    sources: Vec<Source>,
}

#[derive(Deserialize)]
struct Deleted {
    deleted: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Restriction {
    pubkey: String,
    banned: bool,
    actor_pubkey: String,
    updated_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Page<T> {
    items: Vec<T>,
    next_cursor: Option<String>,
}

#[derive(Deserialize)]
struct Items<T> {
    items: Vec<T>,
}

#[derive(Deserialize)]
struct Community {
    id: String,
    host: String,
}

#[derive(Deserialize)]
struct Member {
    pubkey: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemberDetail {
    pubkey: String,
    banned: bool,
    is_staff: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventPreview {
    id: String,
    author_pubkey: String,
    kind: u64,
    content: String,
    created_at: String,
}

#[derive(Deserialize)]
#[serde(tag = "state", rename_all = "lowercase")]
enum DirectAction {
    #[serde(rename_all = "camelCase")]
    Succeeded {
        action_id: String,
        replayed: bool,
    },
    Pending {},
}

fn is<T: DeserializeOwned>(value: &Value) -> bool {
    T::deserialize(value).is_ok()
}

/// Whether `body` (`None` when empty) is a success for `request`.
pub(super) fn valid(request: &StaffRequest, body: Option<&Value>) -> bool {
    use StaffRequest as R;
    let Some(v) = body else {
        // Only lifting a restriction answers 204 No Content.
        return matches!(request, R::LiftRestriction { .. });
    };
    match request {
        R::Probe {} => is::<Probe>(v),
        R::ListReports { .. } => is::<Vec<Report>>(v),
        R::GetReport { .. } => is::<Report>(v),
        R::ResolveReport { .. } | R::CancelReport { .. } => is::<Resolution>(v),
        R::ReopenReport { .. } => is::<Status>(v),
        R::ListFeedback {} => is::<Vec<FeedbackSummary>>(v),
        R::GetFeedback { .. } => is::<Feedback>(v),
        R::SetFeedbackStatus { .. } => is::<FeedbackState>(v),
        R::ListOperators {} => is::<Vec<Operator>>(v),
        R::PutOperator { .. } => is::<Operator>(v),
        R::DeleteOperator { .. } => is::<Deleted>(v),
        R::ListRestrictions { .. } => is::<Page<Restriction>>(v),
        R::LiftRestriction { .. } => false,
        R::DirectAction { .. } => is::<DirectAction>(v),
        R::ListCommunities { .. } => is::<Page<Community>>(v),
        R::SearchMembers { .. } => is::<Items<Member>>(v),
        R::GetMember { .. } => is::<MemberDetail>(v),
        R::GetEvent { .. } => is::<EventPreview>(v),
    }
}
