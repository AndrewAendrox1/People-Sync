export function normalizeOtp(value: unknown) {
  const code = String(value ?? '').replace(/[\s\u200B-\u200D\uFEFF-]/g, '');
  if (!/^\d{6}$/.test(code)) throw new Error('Enter the six-digit code from your latest verification email.');
  return code;
}

// Successful verification consumes the OTP. Later session failures must never
// send the user back through that same one-time operation.
export async function verifyEmailOnce(
  verify: () => Promise<{error?: {message?: string} | null}>,
  onVerified: () => void | Promise<void>,
) {
  const result = await verify();
  if (result.error) throw new Error(result.error.message || 'This code is invalid or expired. Request a new code.');
  await onVerified();
}
