// Freebie Radar visual identity.
// Ultramarine "radar" blue for brand and actions, a price-sticker yellow reserved for FREE,
// and deep indigo ink for text and the Deal Score. Contrast checked: ink on chalk 15:1,
// ultramarine on white 7.6:1, muted on chalk 6:1, ink on sticker yellow 13:1.
export const colors = {
  bg: '#F3F4FB', // chalk
  surface: '#FFFFFF',
  ink: '#16143B',
  muted: '#5A5980',
  line: '#E0E1F0',
  accent: '#2F2BE6', // ultramarine
  accentSoft: '#E6E6FD',
  accentDeep: '#1D1AA8',
  sticker: '#FFD23F', // reserved for "Free"
  stickerSoft: '#FFF3C2',
  deal: '#16143B',
  dealSoft: '#E6E6FD',
  danger: '#C42B31',
  dangerSoft: '#FFE3E3',
  caution: '#9A4A00',
  cautionSoft: '#FFEBD6',
  sponsored: '#5B2EA6',
  sponsoredSoft: '#EFE5FB',
  placeholder: '#8A89AB',
  imageBg: '#E4E5F5',
};
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };
export const radius = { sm: 8, md: 14, lg: 20, xl: 28, pill: 999 };

// 'display' is a marker resolved by <Text> to Bricolage Grotesque; everything else is DM Sans.
export const display = 'display' as const;
export const type = {
  hero: { fontFamily: display, fontSize: 32, lineHeight: 36, fontWeight: '800' as const, color: '#FFFFFF', letterSpacing: -0.8 },
  title: { fontFamily: display, fontSize: 28, lineHeight: 32, fontWeight: '800' as const, color: colors.ink, letterSpacing: -0.6 },
  h2: { fontFamily: display, fontSize: 20, lineHeight: 24, fontWeight: '700' as const, color: colors.ink, letterSpacing: -0.3 },
  body: { fontSize: 15, color: colors.ink, lineHeight: 22 },
  small: { fontSize: 13, color: colors.muted, lineHeight: 18 },
  label: { fontSize: 13, fontWeight: '700' as const, color: colors.muted },
};
export const shadow = {
  card: { shadowColor: '#16143B', shadowOpacity: 0.08, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 3 },
};
