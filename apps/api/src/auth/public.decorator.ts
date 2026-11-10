import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'auth:public';

/** The route stays reachable without a token. Ownership is not implied. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
