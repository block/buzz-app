import { Component, type ReactNode } from "react";
import type { PageProps, RegisteredPage } from "./service";

class PageBoundary extends Component<
  { children: ReactNode },
  { error: string | null }
> {
  state: { error: string | null } = { error: null };
  static getDerivedStateFromError(error: unknown) {
    return { error: String(error) };
  }
  render() {
    return this.state.error ? (
      <Failure message={this.state.error} />
    ) : (
      this.props.children
    );
  }
}
function Failure({ message }: { message: string }) {
  return (
    <div role="alert" className="notice">
      <h2>This page couldn’t open</h2>
      <p>{message}</p>
      <p>Open Settings to disable, delete, or roll back this plugin.</p>
    </div>
  );
}
export function PageView({
  page,
  companion,
}: { page: RegisteredPage } & PageProps) {
  const Page = page.component;
  return (
    <PageBoundary key={`${page.key}:${page.revision}`}>
      <Page companion={companion} />
    </PageBoundary>
  );
}
