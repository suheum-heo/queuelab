import { safeReturnPath } from './auth.service';

describe('safeReturnPath', () => {
  it('keeps a path inside the app', () => {
    expect(safeReturnPath('/jobs/10000000-0000-4000-8000-000000000001')).toBe(
      '/jobs/10000000-0000-4000-8000-000000000001',
    );
  });

  it('drops an external or sign-in target', () => {
    expect(safeReturnPath(null)).toBe('/dashboard');
    expect(safeReturnPath('https://evil.test/jobs')).toBe('/dashboard');
    expect(safeReturnPath('//evil.test')).toBe('/dashboard');
    expect(safeReturnPath('/sign-in')).toBe('/dashboard');
  });
});
