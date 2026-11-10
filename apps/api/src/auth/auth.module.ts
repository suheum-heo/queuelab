import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { DevOidcController } from './dev-oidc.controller';
import { DevOidcService } from './dev-oidc.service';
import { TokenService } from './token.service';

@Module({
  controllers: [AuthController, DevOidcController],
  providers: [
    DevOidcService,
    TokenService,
    AuthService,
    AuthGuard,
    { provide: APP_GUARD, useExisting: AuthGuard },
  ],
  exports: [TokenService],
})
export class AuthModule {}
