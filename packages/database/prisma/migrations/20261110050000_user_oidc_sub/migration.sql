ALTER TABLE "users" ADD COLUMN "oidc_sub" TEXT;

CREATE UNIQUE INDEX "users_oidc_sub_key" ON "users"("oidc_sub");
