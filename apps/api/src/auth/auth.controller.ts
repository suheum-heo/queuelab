import { Controller, Get, HttpCode, HttpStatus, Post, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { AuthUser } from './auth-user';
import { AuthService, SignInError } from './auth.service';
import {
  clearAuthCookies,
  readCookie,
  writeOidcCookie,
  writeSessionCookie,
} from './cookies';
import { CurrentUser } from './current-user.decorator';
import { oidcSettings } from './oidc-settings';
import { isIsolatedDevHost } from './production-config';
import { Public } from './public.decorator';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Get('login')
  @Public()
  @ApiOperation({ summary: 'Start the OpenID authorization-code flow' })
  login(@Query('return') returnTo: string | undefined, @Req() request: Request, @Res() response: Response): void {
    const settings = oidcSettings();
    const host = Array.isArray(request.headers.host) ? request.headers.host[0] : request.headers.host;
    if (settings.dev && !isIsolatedDevHost(host)) {
      response.status(404).type('text').send('Local sign-in is only available from localhost.');
      return;
    }
    const begun = this.auth.begin(returnTo);
    writeOidcCookie(response, request, begun.cookie);
    response.redirect(begun.url);
  }

  @Get('callback')
  @Public()
  @ApiOperation({ summary: 'Finish sign-in and store the ID token in an HttpOnly cookie' })
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    try {
      const session = await this.auth.complete({
        code: text(code),
        state: text(state),
        error: text(error),
        cookie: readCookie(header(request.headers.cookie), 'queuelab_oidc'),
      });
      writeSessionCookie(response, request, session.token, session.maxAgeMs);
      response.clearCookie('queuelab_oidc', { path: '/' });
      response.redirect(session.redirectTo);
    } catch (caught) {
      clearAuthCookies(response, request);
      const message =
        caught instanceof SignInError ? caught.message : 'Sign-in could not be verified. Try again.';
      const origin = oidcSettings().webOrigin;
      response.redirect(`${origin}/sign-in?error=${encodeURIComponent(message)}`);
    }
  }

  @Post('logout')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Clear the sign-in cookie' })
  logout(@Req() request: Request, @Res({ passthrough: true }) response: Response): void {
    clearAuthCookies(response, request);
  }

  @Get('me')
  @ApiOperation({ summary: 'The user behind the current token' })
  me(@CurrentUser() user: AuthUser): AuthUser {
    return user;
  }
}

function text(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
