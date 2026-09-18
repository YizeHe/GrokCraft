/** Server-side Turnstile siteverify. Token is never trusted from the browser alone. */

type TurnstileVerifyResponse = {
  success?: boolean;
  "error-codes"?: string[];
};

export async function verifyTurnstile(
  env: Env,
  token: string,
  ip: string | null,
): Promise<string | null> {
  const secret = env.TURNSTILE_SECRET_KEY;
  if (!secret) return "人机验证未配置";
  const value = token.trim();
  if (!value) return "请完成人机验证";

  const body = new URLSearchParams();
  body.set("secret", secret);
  body.set("response", value);
  if (ip) body.set("remoteip", ip);

  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = (await res.json().catch(() => null)) as TurnstileVerifyResponse | null;
  if (!data?.success) return "人机验证失败，请重试";
  return null;
}

export function clientIp(request: Request): string | null {
  return request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() || null;
}

export function turnstileTokenFromBody(body: Record<string, unknown>): string {
  const raw = body.cfTurnstileResponse ?? body["cf-turnstile-response"] ?? body.turnstileToken ?? "";
  return typeof raw === "string" ? raw : "";
}
