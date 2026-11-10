import { Controller, Get, Header, NotFoundException, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { DevOidcService } from './dev-oidc.service';
import { isIsolatedDevHost } from './production-config';
import { Public } from './public.decorator';

/** Local authorization server. Disabled once OIDC_ISSUER points at a real provider. */
@Public()
@Controller('oidc')
export class DevOidcController {
  constructor(private readonly dev: DevOidcService) {}

  @Get('.well-known/openid-configuration')
  discovery(@Req() request: Request): Record<string, unknown> {
    this.assertEnabled(request);
    return this.dev.discovery();
  }

  @Get('jwks')
  jwks(@Req() request: Request): { keys: unknown[] } {
    this.assertEnabled(request);
    return this.dev.jwks();
  }

  @Get('authorize')
  @Header('content-type', 'text/html; charset=utf-8')
  authorize(@Req() request: Request): string {
    this.assertEnabled(request);
    const html = this.dev.form(record(request.query));
    if (!html) throw new NotFoundException('Sign-in request was rejected.');
    return html;
  }

  @Post('authorize')
  submit(@Req() request: Request, @Res() response: Response): void {
    this.assertEnabled(request);
    const result = this.dev.submit(record(request.body));
    if (result.kind === 'form') {
      response.status(400).type('html').send(result.html);
      return;
    }
    response.redirect(result.location);
  }

  @Post('token')
  async token(@Req() request: Request, @Res() response: Response): Promise<void> {
    this.assertEnabled(request);
    try {
      response.json(await this.dev.exchange(record(request.body)));
    } catch {
      response.status(400).json({ error: 'invalid_grant' });
    }
  }

  private assertEnabled(request: Request): void {
    const host = Array.isArray(request.headers.host) ? request.headers.host[0] : request.headers.host;
    if (!this.dev.enabled() || !isIsolatedDevHost(host)) throw new NotFoundException();
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
