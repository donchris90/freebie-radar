/**
 * Reference catalog of countries the product can be switched on in. This is static reference data
 * (ISO 3166 code, the country's main ISO 4217 currency, distance unit, a suggested IANA time zone),
 * not product data. Which countries are actually open for use is decided in the admin dashboard.
 */
export interface CatalogCountry {
  code: string;
  name: string;
  currency: string;
  distanceUnit: 'mi' | 'km';
  defaultTimeZone: string;
}

const c = (code: string, name: string, currency: string, distanceUnit: 'mi' | 'km', defaultTimeZone: string): CatalogCountry => ({
  code, name, currency, distanceUnit, defaultTimeZone,
});

export const COUNTRY_CATALOG: CatalogCountry[] = [
  c('US', 'United States', 'USD', 'mi', 'America/New_York'),
  c('CA', 'Canada', 'CAD', 'km', 'America/Toronto'),
  c('GB', 'United Kingdom', 'GBP', 'mi', 'Europe/London'),
  c('AU', 'Australia', 'AUD', 'km', 'Australia/Sydney'),
  c('NZ', 'New Zealand', 'NZD', 'km', 'Pacific/Auckland'),
  c('IE', 'Ireland', 'EUR', 'km', 'Europe/Dublin'),
  c('DE', 'Germany', 'EUR', 'km', 'Europe/Berlin'),
  c('FR', 'France', 'EUR', 'km', 'Europe/Paris'),
  c('ES', 'Spain', 'EUR', 'km', 'Europe/Madrid'),
  c('IT', 'Italy', 'EUR', 'km', 'Europe/Rome'),
  c('NL', 'Netherlands', 'EUR', 'km', 'Europe/Amsterdam'),
  c('SE', 'Sweden', 'SEK', 'km', 'Europe/Stockholm'),
  c('NO', 'Norway', 'NOK', 'km', 'Europe/Oslo'),
  c('DK', 'Denmark', 'DKK', 'km', 'Europe/Copenhagen'),
  c('CH', 'Switzerland', 'CHF', 'km', 'Europe/Zurich'),
  c('ZA', 'South Africa', 'ZAR', 'km', 'Africa/Johannesburg'),
  c('NG', 'Nigeria', 'NGN', 'km', 'Africa/Lagos'),
  c('GH', 'Ghana', 'GHS', 'km', 'Africa/Accra'),
  c('KE', 'Kenya', 'KES', 'km', 'Africa/Nairobi'),
  c('IN', 'India', 'INR', 'km', 'Asia/Kolkata'),
  c('SG', 'Singapore', 'SGD', 'km', 'Asia/Singapore'),
  c('AE', 'United Arab Emirates', 'AED', 'km', 'Asia/Dubai'),
  c('JP', 'Japan', 'JPY', 'km', 'Asia/Tokyo'),
  c('MX', 'Mexico', 'MXN', 'km', 'America/Mexico_City'),
  c('BR', 'Brazil', 'BRL', 'km', 'America/Sao_Paulo'),
];

/** Enabled the first time the catalog is loaded. After that, the admin dashboard decides. */
export const DEFAULT_LAUNCH_COUNTRIES = ['US', 'CA', 'GB'];
