// The page contract ships one JavaScript file; scope embedded styles to this plugin.
export const beaconStyles = `
.pr-beacon {
  --beacon-background: #f5f7f8;
  --beacon-surface: #ffffff;
  --beacon-text: #202d35;
  --beacon-muted: #5e6d76;
  --beacon-border: #dfe6e9;
  --beacon-hover: #f0f5f5;
  --beacon-accent: #137567;
  --beacon-accent-soft: #e6f3ef;
  --beacon-warning: #80571b;
  --beacon-warning-soft: #fff8e8;
  --beacon-add: #186c48;
  --beacon-add-soft: #e7f5ec;
  --beacon-remove: #a44343;
  --beacon-remove-soft: #fff0ef;
  box-sizing: border-box;
  min-height: calc(100vh - 56px);
  padding: 24px 32px 48px;
  border: 1px solid var(--beacon-border);
  border-radius: 12px;
  background: var(--beacon-background);
  color: var(--beacon-text);
  font: calc(14px * var(--buzz-text-scale, 1))/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
:root[data-color-mode="dark"] .pr-beacon {
  --beacon-background: #171e22; --beacon-surface: #202a2f; --beacon-text: #e6edf0; --beacon-muted: #a2b2ba; --beacon-border: #35434a; --beacon-hover: #2a373d; --beacon-accent: #70d2b8; --beacon-accent-soft: #253e37; --beacon-warning: #e7c57c; --beacon-warning-soft: #3c3425; --beacon-add: #97dfb6; --beacon-add-soft: #253d31; --beacon-remove: #efa5a0; --beacon-remove-soft: #432d30;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-color-mode]) .pr-beacon {
    --beacon-background: #171e22; --beacon-surface: #202a2f; --beacon-text: #e6edf0; --beacon-muted: #a2b2ba; --beacon-border: #35434a; --beacon-hover: #2a373d; --beacon-accent: #70d2b8; --beacon-accent-soft: #253e37; --beacon-warning: #e7c57c; --beacon-warning-soft: #3c3425; --beacon-add: #97dfb6; --beacon-add-soft: #253d31; --beacon-remove: #efa5a0; --beacon-remove-soft: #432d30;
  }
}
.pr-beacon *, .pr-beacon *::before, .pr-beacon *::after { box-sizing: border-box; }
.pr-beacon .beacon-workspace { width: 100%; max-width: 1120px; margin: 0 auto; }
.pr-beacon h1, .pr-beacon h2, .pr-beacon h3, .pr-beacon p { margin: 0; }
.pr-beacon h1 { font-size: calc(28px * var(--buzz-text-scale, 1)); font-weight: 700; line-height: 1.25; letter-spacing: -.7px; }
.pr-beacon h2 { font-size: calc(27px * var(--buzz-text-scale, 1)); font-weight: 650; line-height: 1.25; letter-spacing: -.55px; }
.pr-beacon h3 { font-size: calc(15px * var(--buzz-text-scale, 1)); font-weight: 650; line-height: 1.4; }
.pr-beacon p { line-height: 1.6; }
.pr-beacon button, .pr-beacon input, .pr-beacon select { font: inherit; }
.pr-beacon button { min-height: 34px; border: 1px solid var(--beacon-border); border-radius: 7px; padding: 6px 12px; background: var(--beacon-surface); color: var(--beacon-text); font-size: calc(13px * var(--buzz-text-scale, 1)); font-weight: 550; cursor: pointer; transition: background .12s, border-color .12s; }
.pr-beacon button:hover:not(:disabled) { background: var(--beacon-hover); border-color: var(--beacon-muted); }
.pr-beacon button:disabled { opacity: .48; cursor: not-allowed; }
.pr-beacon :is(button,input,select,summary):focus-visible { outline: 2px solid var(--beacon-accent); outline-offset: 3px; }
.pr-beacon .beacon-primary { background: #137567; color: #fff; border-color: #137567; }
.pr-beacon .beacon-primary:hover:not(:disabled) { background: #0c6155; border-color: #0c6155; }
.pr-beacon .beacon-quiet { background: transparent; border-color: transparent; color: var(--beacon-muted); }
.pr-beacon .beacon-muted { color: var(--beacon-muted); font-size: calc(13px * var(--buzz-text-scale, 1)); }
.pr-beacon .beacon-header { display: flex; gap: 14px; align-items: center; margin-bottom: 28px; }
.pr-beacon .beacon-header p { margin-top: 5px; }
.pr-beacon .beacon-mark { display: grid; place-items: center; width: 46px; height: 46px; flex: 0 0 46px; border: 1px solid var(--beacon-border); border-radius: 12px; background: var(--beacon-surface); color: var(--beacon-accent); }
.pr-beacon .beacon-tabs { display: flex; gap: 24px; border-bottom: 1px solid var(--beacon-border); margin-bottom: 22px; }
.pr-beacon .beacon-tabs button { position: relative; padding: 0 2px 13px; min-height: 40px; border: 0; border-radius: 0; background: transparent; color: var(--beacon-muted); white-space: nowrap; }
.pr-beacon .beacon-tabs button:hover:not(:disabled) { color: var(--beacon-text); background: transparent; }
.pr-beacon .beacon-tabs button[aria-current="page"] { color: var(--beacon-accent); }
.pr-beacon .beacon-tabs button[aria-current="page"]::after { content: ""; position: absolute; height: 2px; background: var(--beacon-accent); bottom: -1px; left: 0; right: 0; }
.pr-beacon .beacon-toolbar { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-bottom: 20px; }
.pr-beacon .beacon-group-title { margin: 24px 0 10px; font-size: calc(13px * var(--buzz-text-scale, 1)); color: var(--beacon-muted); }
.pr-beacon .beacon-inbox > section:first-of-type .beacon-group-title { margin-top: 0; }
.pr-beacon .beacon-pr-list { list-style: none; padding: 0; margin: 0; border: 1px solid var(--beacon-border); border-radius: 10px; overflow: hidden; background: var(--beacon-surface); }
.pr-beacon .beacon-pr-row { display: flex; align-items: center; gap: 14px; padding: 17px 16px; margin: 0; border-bottom: 1px solid var(--beacon-border); }
.pr-beacon .beacon-pr-row:last-child { border-bottom: 0; }
.pr-beacon .beacon-pr-row:hover { background: var(--beacon-hover); }
.pr-beacon .beacon-pr-symbol { color: var(--beacon-accent); font-size: calc(23px * var(--buzz-text-scale, 1)); align-self: flex-start; line-height: 1.2; }
.pr-beacon .beacon-pr-link { flex: 1; min-width: 0; padding: 0; text-align: left; border: 0; border-radius: 3px; background: transparent; display: flex; flex-direction: column; align-items: flex-start; gap: 5px; }
.pr-beacon .beacon-pr-link:hover:not(:disabled) { background: transparent; }
.pr-beacon .beacon-pr-title { font-size: calc(15px * var(--buzz-text-scale, 1)); font-weight: 600; line-height: 1.4; overflow-wrap: anywhere; }
.pr-beacon .beacon-pr-meta { display: flex; flex-wrap: wrap; gap: 4px 10px; color: var(--beacon-muted); font-size: calc(12px * var(--buzz-text-scale, 1)); font-weight: 400; overflow-wrap: anywhere; }
.pr-beacon .beacon-row-labels { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; max-width: 30%; }
.pr-beacon .beacon-badge { display: inline-flex; align-items: center; border: 1px solid var(--beacon-border); border-radius: 5px; padding: 2px 7px; font-size: calc(11px * var(--buzz-text-scale, 1)); font-weight: 550; line-height: 1.5; color: var(--beacon-muted); background: var(--beacon-background); overflow-wrap: anywhere; }
.pr-beacon .beacon-accent, .pr-beacon .beacon-status-ready-to-merge { background: var(--beacon-accent-soft); color: var(--beacon-accent); border-color: transparent; }
.pr-beacon .beacon-status-failing-checks, .pr-beacon .beacon-status-needs-response { color: var(--beacon-warning); background: var(--beacon-warning-soft); border-color: transparent; }
.pr-beacon .beacon-hidden { margin-top: 22px; color: var(--beacon-muted); font-size: calc(13px * var(--buzz-text-scale, 1)); }
.pr-beacon .beacon-hidden summary { cursor: pointer; padding: 8px 0; }
.pr-beacon .beacon-hidden ul { padding-left: 20px; }
.pr-beacon .beacon-hidden li { padding: 6px 0; }
.pr-beacon .beacon-hidden button { margin-left: 12px; }
.pr-beacon [role="alert"] { padding: 12px 14px; border-radius: 7px; color: var(--beacon-warning); background: var(--beacon-warning-soft); font-size: calc(13px * var(--buzz-text-scale, 1)); margin: 12px 0; overflow-wrap: anywhere; }
.pr-beacon .beacon-backbar { display: flex; align-items: center; gap: 10px; color: var(--beacon-muted); font-size: calc(12px * var(--buzz-text-scale, 1)); margin: -8px 0 16px -10px; }
.pr-beacon .beacon-detail-header { margin-bottom: 18px; }
.pr-beacon .beacon-eyebrow { color: var(--beacon-muted); font-size: calc(12px * var(--buzz-text-scale, 1)); font-weight: 550; }
.pr-beacon .beacon-detail-header > .beacon-eyebrow { margin-bottom: 9px; }
.pr-beacon .beacon-detail-header > .beacon-eyebrow span { margin-left: 8px; }
.pr-beacon .beacon-detail-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 10px 20px; margin-top: 13px; color: var(--beacon-muted); font-size: calc(12px * var(--buzz-text-scale, 1)); }
.pr-beacon .beacon-detail-meta strong { color: var(--beacon-text); font-weight: 500; }
.pr-beacon .beacon-branches { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 7px; }
.pr-beacon code { font: calc(12px * var(--buzz-text-scale, 1))/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; }
.pr-beacon .beacon-branches code { border: 1px solid var(--beacon-border); border-radius: 4px; padding: 1px 6px; background: var(--beacon-surface); overflow-wrap: anywhere; }
.pr-beacon .beacon-review-grid { display: grid; grid-template-columns: minmax(0, 1fr) 260px; grid-template-areas: "summary approval" "files approval"; gap: 18px; align-items: start; }
.pr-beacon .beacon-card { background: var(--beacon-surface); border: 1px solid var(--beacon-border); border-radius: 10px; padding: 20px; min-width: 0; }
.pr-beacon .beacon-section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.pr-beacon .beacon-summary { grid-area: summary; }
.pr-beacon .beacon-sharing { color: var(--beacon-muted); font-size: calc(12px * var(--buzz-text-scale, 1)); }
.pr-beacon .beacon-sharing strong { color: var(--beacon-text); font-weight: 600; }
.pr-beacon .beacon-coverage { margin: 14px 0 !important; padding: 10px 12px; border-left: 2px solid var(--beacon-border); background: var(--beacon-background); color: var(--beacon-muted); font-size: calc(12px * var(--buzz-text-scale, 1)); overflow-wrap: anywhere; }
.pr-beacon .beacon-reply { border-top: 1px solid var(--beacon-border); padding-top: 15px; margin-top: 16px; }
.pr-beacon .beacon-reply pre { margin: 9px 0 12px; font: inherit; font-size: calc(14px * var(--buzz-text-scale, 1)); line-height: 1.75; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--beacon-text); }
.pr-beacon .beacon-reply-note { color: var(--beacon-muted); font-size: calc(11px * var(--buzz-text-scale, 1)); }
.pr-beacon .beacon-files { grid-area: files; min-width: 0; }
.pr-beacon .beacon-count { margin-left: 7px; color: var(--beacon-muted); font-size: calc(12px * var(--buzz-text-scale, 1)); font-weight: 400; }
.pr-beacon .beacon-diff-totals { display: flex; gap: 10px; font: calc(12px * var(--buzz-text-scale, 1)) ui-monospace, SFMono-Regular, Menlo, monospace; }
.pr-beacon .beacon-added { color: var(--beacon-add); }
.pr-beacon .beacon-removed { color: var(--beacon-remove); }
.pr-beacon .beacon-file { background: var(--beacon-surface); border: 1px solid var(--beacon-border); border-radius: 8px; margin-top: 8px; overflow: hidden; }
.pr-beacon .beacon-file summary { cursor: pointer; padding: 12px 14px; font: calc(12px * var(--buzz-text-scale, 1))/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
.pr-beacon .beacon-file summary:hover { background: var(--beacon-hover); }
.pr-beacon .beacon-filename { margin-left: 5px; }
.pr-beacon .beacon-file-stats { margin-left: 12px; white-space: nowrap; }
.pr-beacon .beacon-diff { margin: 0; padding: 10px 0; overflow-x: auto; border-top: 1px solid var(--beacon-border); background: var(--beacon-surface); tab-size: 2; }
.pr-beacon .beacon-diff code { display: block; min-width: max-content; }
.pr-beacon .beacon-diff code > span { display: block; padding: 0 14px; min-height: 21px; }
.pr-beacon .beacon-diff-add { color: var(--beacon-add); background: var(--beacon-add-soft); }
.pr-beacon .beacon-diff-remove { color: var(--beacon-remove); background: var(--beacon-remove-soft); }
.pr-beacon .beacon-diff-hunk { color: var(--beacon-muted); background: var(--beacon-hover); }
.pr-beacon .beacon-no-patch { border-top: 1px solid var(--beacon-border); padding: 14px; font-size: calc(12px * var(--buzz-text-scale, 1)); color: var(--beacon-muted); }
.pr-beacon .beacon-approval { grid-area: approval; }
.pr-beacon .beacon-approval > .beacon-muted { margin-top: 9px; font-size: calc(12px * var(--buzz-text-scale, 1)); }
.pr-beacon .beacon-commit { display: flex; justify-content: space-between; align-items: center; margin: 20px 0 14px; gap: 10px; font-size: calc(11px * var(--buzz-text-scale, 1)); color: var(--beacon-muted); }
.pr-beacon .beacon-commit code { color: var(--beacon-text); }
.pr-beacon .beacon-approval .beacon-primary { width: 100%; }
.pr-beacon .beacon-approval-note { font-size: calc(11px * var(--buzz-text-scale, 1)); color: var(--beacon-muted); margin-top: 13px; }
.pr-beacon .beacon-approved { padding: 9px 12px; border-radius: 7px; background: var(--beacon-accent-soft); color: var(--beacon-accent); font-weight: 600; }
.pr-beacon .beacon-settings { max-width: 760px; }
.pr-beacon .beacon-settings-card { margin: 16px 0; max-width: 760px; }
.pr-beacon .beacon-settings-card > p { color: var(--beacon-muted); font-size: calc(13px * var(--buzz-text-scale, 1)); margin: 10px 0 16px; }
.pr-beacon .beacon-settings-card label { display: flex; flex-direction: column; gap: 7px; font-size: calc(13px * var(--buzz-text-scale, 1)); font-weight: 550; margin-top: 16px; }
.pr-beacon .beacon-settings-card input:not([type="checkbox"]), .pr-beacon .beacon-settings-card select { display: block; width: 100%; min-height: 38px; border: 1px solid var(--beacon-border); border-radius: 6px; background: var(--beacon-surface); color: var(--beacon-text); padding: 8px 10px; font-size: calc(13px * var(--buzz-text-scale, 1)); }
.pr-beacon .beacon-settings-card form button { margin-top: 14px; }
.pr-beacon .beacon-settings-card .beacon-checkbox { flex-direction: row; align-items: flex-start; gap: 10px; font-weight: 400; color: var(--beacon-muted); }
.pr-beacon .beacon-checkbox input { width: 16px; height: 16px; margin-top: 2px; accent-color: var(--beacon-accent); flex-shrink: 0; }
@media (max-width: 720px) {
  .pr-beacon { padding: 22px 16px 32px; }
  .pr-beacon h1 { font-size: calc(25px * var(--buzz-text-scale, 1)); }
  .pr-beacon h2 { font-size: calc(23px * var(--buzz-text-scale, 1)); }
  .pr-beacon .beacon-header { margin-bottom: 22px; }
  .pr-beacon .beacon-tabs { gap: 18px; overflow-x: auto; }
  .pr-beacon .beacon-review-grid { grid-template-columns: minmax(0, 1fr); grid-template-areas: "summary" "files" "approval"; gap: 18px; }
  .pr-beacon .beacon-pr-row { gap: 9px; padding: 14px 11px; flex-wrap: wrap; }
  .pr-beacon .beacon-pr-link { flex-basis: calc(100% - 80px); }
  .pr-beacon .beacon-row-labels { max-width: 100%; margin-left: 27px; justify-content: flex-start; }
  .pr-beacon .beacon-row-labels:empty { display: none; }
  .pr-beacon .beacon-pr-row > .beacon-quiet { margin-left: auto; }
  .pr-beacon .beacon-card { padding: 17px; }
  .pr-beacon .beacon-file-stats { display: inline-block; }
}
`;
