import { parseBool } from './transform';

describe('parseBool', () => {
  it.each([[true, true], ['true', true], ['TRUE', true], ['1', true], [1, true], [false, false], ['false', false], ['False', false], ['0', false], [0, false]])('reads %p as %p', (input, out) => {
    expect(parseBool(input)).toBe(out);
  });
  it.each([[undefined], [null], ['']])('treats %p as omitted', (input) => {
    expect(parseBool(input)).toBeUndefined();
  });
  it.each([['yes'], ['2'], ['truee'], ['null']])('leaves %p alone so validation rejects it', (input) => {
    expect(parseBool(input)).toBe(input);
  });
});
