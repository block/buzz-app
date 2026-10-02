import type { EventTemplate, VerifiedEvent } from "nostr-tools";

export interface Signer {
  getPublicKey(): Promise<string>;
  signEvent(event: EventTemplate, signal?: AbortSignal): Promise<VerifiedEvent>;
  /** Native hosts authenticate and send exact bytes without exposing credentials to JS. */
  request?(url: string, body: string, signal?: AbortSignal): Promise<Response>;
  /** Native hosts sign and send `PUT /upload` for these exact bytes. */
  upload?(file: File, signal: AbortSignal): Promise<Response>;
  /** Native hosts serve relay `/media/` URLs through an authenticated proxy. */
  media?(url: string): string;
}

export interface SigningDelegateScope {
  relay: string;
  identity: string;
}

export type SigningDelegateFactory = (scope: SigningDelegateScope) => Signer;

/** Select and bind one delegate for a captured relay and public identity. */
export function selectSigningDelegate(
  factory: SigningDelegateFactory | undefined,
  fallback: Signer,
  scope: SigningDelegateScope,
): Signer {
  return bindSigningDelegate(factory?.(scope) ?? fallback, scope);
}

/** Bind event signing to the relay and public identity selected by the caller. */
export function bindSigningDelegate(
  delegate: Signer,
  scope: SigningDelegateScope,
): Signer {
  const relay = new URL(scope.relay).origin;
  const identity = scope.identity;
  const bound: Signer = {
    getPublicKey: async () => identity,
    async signEvent(event, signal) {
      signal?.throwIfAborted();
      const signed = await delegate.signEvent(event, signal);
      signal?.throwIfAborted();
      if (signed.pubkey !== identity)
        throw new Error("Signing delegate identity mismatch");
      return signed;
    },
  };
  const request = delegate.request;
  if (request)
    bound.request = (url, body, signal) => {
      if (new URL(url).origin !== relay)
        throw new Error("Signing delegate relay mismatch");
      return request.call(delegate, url, body, signal);
    };
  const upload = delegate.upload;
  if (upload)
    bound.upload = (file, signal) => upload.call(delegate, file, signal);
  const media = delegate.media;
  if (media) bound.media = (url) => media.call(delegate, url);
  return bound;
}
