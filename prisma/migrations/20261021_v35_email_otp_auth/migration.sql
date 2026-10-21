-- v3.5 email-OTP auth: accounts created by verifying an email code have no
-- password. passwordHash becomes optional so OTP-first users can exist
-- (they sign in with codes; password login is unavailable for them).
ALTER TABLE "User" ALTER COLUMN "passwordHash" DROP NOT NULL;
