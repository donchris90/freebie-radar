import { guardMessage, hasPhoneNumber, previewOf } from './messaging';

describe('guardMessage', () => {
  it.each([
    'Is it still available?',
    'I can pick up at 5pm tomorrow',
    'Would you take £15 for it?',
    'It is 120 x 60 cm and weighs about 25 kg',
    'I paid 1,500 for it in 2019',
    'Free until 2026-12-01 at 10:30',
  ])('lets ordinary messages through: %s', (t) => {
    expect(guardMessage(t)).toEqual({ ok: true, flagged: false });
  });

  it.each([
    ['email', 'write me at sam@example.com please'],
    ['obfuscated email', 'sam (at) example (dot) com'],
    ['phone', 'call 07700 900123 after six'],
    ['international phone', 'my number is +1 (212) 555-0147'],
    ['link', 'see https://example.org/photo'],
    ['bare domain', 'look at mystuff.com for more'],
    ['www', 'www.shop.example/item'],
  ])('refuses %s', (_n, t) => {
    const r = guardMessage(t);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.length).toBeGreaterThan(20);
  });

  it.each([
    'Please send a deposit and I will hold it',
    'pay first and my courier will collect',
    'I only accept gift cards',
    'Can we move to WhatsApp?',
  ])('delivers but flags: %s', (t) => {
    const r = guardMessage(t);
    expect(r.ok && r.flagged).toBe(true);
  });

  it('phone detection needs eight digits', () => {
    expect(hasPhoneNumber('open 9-5, unit 12')).toBe(false);
    expect(hasPhoneNumber('0121 496 0000')).toBe(true);
  });

  it('shortens previews', () => {
    expect(previewOf('a'.repeat(200)).length).toBe(80);
    expect(previewOf('  hello \n there ')).toBe('hello there');
  });
});
