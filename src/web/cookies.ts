import { Request, Response } from 'express';

export const SESSION_COOKIE = 'inf_staff';
const FLASH_COOKIE = 'inf_flash';

export function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0 && part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export interface CookieOptions {
  secure: boolean;
  maxAgeMs?: number;
}

export function setCookie(res: Response, name: string, value: string, opts: CookieOptions) {
  res.cookie(name, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: opts.secure,
    path: '/',
    maxAge: opts.maxAgeMs,
  });
}

export function clearCookie(res: Response, name: string) {
  res.clearCookie(name, { path: '/' });
}

export interface Flash {
  type: 'ok' | 'error';
  text: string;
}

/** One-shot message shown on the next page (post/redirect/get). */
export function setFlash(res: Response, flash: Flash, secure: boolean) {
  setCookie(res, FLASH_COOKIE, Buffer.from(JSON.stringify(flash)).toString('base64url'), {
    secure,
    maxAgeMs: 60_000,
  });
}

export function takeFlash(req: Request, res: Response): Flash | undefined {
  const raw = readCookie(req, FLASH_COOKIE);
  if (!raw) return undefined;
  clearCookie(res, FLASH_COOKIE);
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Flash;
    return typeof parsed.text === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}
