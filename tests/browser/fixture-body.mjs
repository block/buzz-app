// Keep body parsing separate from fixture dispatch so a disconnected client can
// retire an incomplete request without hiding handler/JSON errors.
export async function fixtureBody(request, report) {
  let raw = "";
  try {
    for await (const part of request) raw += part;
  } catch (error) {
    if (
      error?.code !== "ECONNRESET" ||
      !request.destroyed ||
      request.complete !== false
    )
      throw error;
    report.cancelledRequests.push({ method: request.method, url: request.url });
    return null;
  }
  return { body: raw ? JSON.parse(raw) : undefined };
}
