/** Only invite claims may repeat after a received 503: an existing member
 * does not consume another invite use. Each call must sign a fresh request
 * with the same identity and body. Keep the caller's deadline across attempts. */
export async function retryInviteClaim(
  request: () => Promise<Response>,
  signal: AbortSignal,
): Promise<Response> {
  signal.throwIfAborted();
  const response = await request();
  signal.throwIfAborted();
  if (response.status !== 503) return response;
  await response.body?.cancel();
  signal.throwIfAborted();
  // Spread a burst's single retry over 0.5–1.5 seconds.
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(
      () => {
        signal.removeEventListener("abort", abort);
        resolve();
      },
      500 + Math.random() * 1000,
    );
    signal.addEventListener("abort", abort, { once: true });
  });
  signal.throwIfAborted();
  const retried = await request();
  signal.throwIfAborted();
  return retried;
}
