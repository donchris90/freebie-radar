export const colors = {
  bg: '#F5F7F4',
  surface: '#FFFFFF',
  ink: '#0F1F2B',
  muted: '#52626E',
  line: '#DDE3E0',
  accent: '#0B8F5C', // radar green: free + positive
  accentSoft: '#DDF3E8',
  deal: '#B45309', // deal-score amber (4.9:1 on white)
  dealSoft: '#FDF0D9',
  danger: '#B42318',
  dangerSoft: '#FDE7E4',
  caution: '#8A5A00',
  cautionSoft: '#FFF1D6',
  sponsored: '#4C3FB5',
  sponsoredSoft: '#E9E6FB',
};
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };
export const radius = { sm: 8, md: 14, lg: 20, pill: 999 };
export const type = {
  title: { fontSize: 24, fontWeight: '700' as const, color: colors.ink },
  h2: { fontSize: 18, fontWeight: '700' as const, color: colors.ink },
  body: { fontSize: 15, color: colors.ink, lineHeight: 21 },
  small: { fontSize: 13, color: colors.muted },
  label: { fontSize: 13, fontWeight: '600' as const, color: colors.muted },
};
