import { CsvError, csvToObjects, parseCsv } from './csv';

describe('csv', () => {
  it('reads quoted fields, doubled quotes, commas and newlines inside quotes', () => {
    expect(parseCsv('a,b\n"x, y","say ""hi"""\n"line1\nline2",z\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"'], ['line1\nline2', 'z']]);
  });
  it('handles CRLF, a byte-order mark, blank lines and a missing final newline', () => {
    expect(parseCsv('﻿a,b\r\n1,2\r\n\r\n3,4')).toEqual([['a', 'b'], ['1', '2'], ['3', '4']]);
  });
  it('refuses an unterminated quote rather than guessing', () => {
    expect(() => parseCsv('a,b\n"oops,1')).toThrow(CsvError);
  });
  it('normalises headers and tolerates short rows', () => {
    const r = csvToObjects('Title, Location Label ,price\nDesk,Leeds\n');
    expect(r.columns).toEqual(['title', 'location_label', 'price']);
    expect(r.rows).toEqual([{ title: 'Desk', location_label: 'Leeds', price: '' }]);
  });
  it('rejects an empty file', () => {
    expect(() => csvToObjects('')).toThrow(CsvError);
  });
});
