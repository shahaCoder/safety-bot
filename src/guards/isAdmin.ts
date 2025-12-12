import { Context } from 'telegraf';

/**
 * Guard function to check if command should be allowed.
 * 
 * Requirements:
 * - ctx.chat.type === 'private' (only private chats)
 * - ctx.from.id is in TELEGRAM_ADMIN_IDS env var
 * 
 * @param ctx - Telegraf context
 * @returns true if allowed, false otherwise
 */
export function isAdminInPrivateChat(ctx: Context): boolean {
  // Must be private chat
  if (ctx.chat?.type !== 'private') {
    return false;
  }

  // Must have from user
  if (!ctx.from?.id) {
    return false;
  }

  // Check admin IDs from environment
  const adminIdsStr = process.env.TELEGRAM_ADMIN_IDS;
  if (!adminIdsStr) {
    return false;
  }

  // Parse comma-separated admin IDs
  const adminIds = adminIdsStr
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
    .map((id) => parseInt(id, 10))
    .filter((id) => !isNaN(id));

  // Check if user ID is in admin list
  return adminIds.includes(ctx.from.id);
}

/**
 * Middleware to guard admin-only commands in private chats.
 * Replies with "Forbidden" if access is denied.
 * 
 * @param ctx - Telegraf context
 * @param next - Next middleware function
 */
export async function requireAdminPrivateChat(
  ctx: Context,
  next: () => Promise<void>
): Promise<void> {
  if (isAdminInPrivateChat(ctx)) {
    return next();
  } else {
    await ctx.reply('Forbidden');
  }
}

