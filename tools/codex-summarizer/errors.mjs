// Only fixed categories cross the HTTP/log boundary; never raw provider output.
const failures = {
  auth_required: [424, 'Dedicated subscription login required'],
  timeout: [408, 'Subscription summary deadline exceeded'],
  cancelled: [408, 'Summary request cancelled'],
  output_limit: [422, 'Subscription output exceeded limit'],
  invalid_notes: [422, 'Subscription returned invalid StructuredNotes'],
  invalid_trace: [422, 'Subscription response failed isolation validation'],
  child_failed: [502, 'Subscription process failed'],
};
export function failure(category, metadata = {}) {
  const error = new Error(failures[category][1]);
  error.category = category;
  error.metadata = metadata;
  return error;
}
export function publicFailure(error) {
  const category = Object.hasOwn(failures, error?.category) ? error.category : 'child_failed';
  const [status, message] = failures[category];
  return {status, body: {error: message, category}};
}
export function childFailure(stderr, metadata) {
  // Missing credentials includes credentials disabled by a prior OAuth refresh failure.
  // No scraping/copying another store or retrying invalidated refresh tokens.
  return failure(/No API key found for openai-codex|refresh_token_reused|invalid_grant|(?:OAuth|token).*?(?:expired|revoked)/i.test(stderr)
    ? 'auth_required' : 'child_failed', metadata);
}
