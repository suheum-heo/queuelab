import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { cookieMutationAllowed } from './csrf';
import { readBearer, readCookie, sessionCookieName } from './cookies';
import { oidcSettings } from './oidc-settings';
import { IS_PUBLIC } from './public.decorator';
import { TokenService } from './token.service';

/**
 * HTTP authorization. A missing or foreign token is rejected here.
 * Socket.IO uses the same token check on the connection, not this guard.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const request = context.switchToHttp().getRequest<Request & { user?: unknown }>();
    const sessionCookie = readCookie(request.headers.cookie, sessionCookieName());
    if (
      !cookieMutationAllowed({
        method: request.method,
        hasSessionCookie: Boolean(sessionCookie),
        csrfHeader: request.headers['x-queuelab-request'],
        origin: request.headers.origin,
        referer: request.headers.referer,
        webOrigin: oidcSettings().webOrigin,
      })
    ) {
      throw new ForbiddenException('Cross-site request was rejected');
    }

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    const token = readBearer(request.headers.authorization) ?? sessionCookie;
    const user = await this.tokens.authenticate(token);
    if (!user) throw new UnauthorizedException('Sign in required');
    request.user = user;
    return true;
  }
}
