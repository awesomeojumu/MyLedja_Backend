import { createHash } from 'node:crypto';
import type { z } from 'zod';
import type { AppConfig } from '../../config/config.schema.js';
import type { Institution, InstitutionList } from './institutions.contract.js';

type Entry = Omit<z.input<typeof Institution>, 'logoUrl'> & {
  /** Set once the logo is uploaded to Cloudinary at `<folder>/institutions/<id>`. */
  logo?: boolean;
};

/** The starter list (Q-B12). Adding an entry here, or a logo, ships with the API, not the app. */
export const INSTITUTIONS: Entry[] = [
  { id: 'access', name: 'Access Bank', kind: 'bank', aliases: ['Access', 'Diamond Bank'] },
  { id: 'citibank', name: 'Citibank Nigeria', kind: 'bank', aliases: ['Citi'] },
  { id: 'ecobank', name: 'Ecobank', kind: 'bank', aliases: [] },
  { id: 'fcmb', name: 'FCMB', kind: 'bank', aliases: ['First City Monument Bank'] },
  { id: 'fidelity', name: 'Fidelity Bank', kind: 'bank', aliases: ['Fidelity'] },
  { id: 'first-bank', name: 'First Bank', kind: 'bank', aliases: ['FirstBank', 'First Bank of Nigeria'] },
  { id: 'globus', name: 'Globus Bank', kind: 'bank', aliases: [] },
  { id: 'gtbank', name: 'GTBank', kind: 'bank', aliases: ['GTCO', 'Guaranty Trust Bank'] },
  { id: 'jaiz', name: 'Jaiz Bank', kind: 'bank', aliases: [] },
  { id: 'keystone', name: 'Keystone Bank', kind: 'bank', aliases: [] },
  { id: 'lotus', name: 'Lotus Bank', kind: 'bank', aliases: [] },
  { id: 'optimus', name: 'Optimus Bank', kind: 'bank', aliases: [] },
  { id: 'parallex', name: 'Parallex Bank', kind: 'bank', aliases: [] },
  { id: 'polaris', name: 'Polaris Bank', kind: 'bank', aliases: ['Skye Bank'] },
  { id: 'premiumtrust', name: 'PremiumTrust Bank', kind: 'bank', aliases: [] },
  { id: 'providus', name: 'Providus Bank', kind: 'bank', aliases: [] },
  { id: 'stanbic', name: 'Stanbic IBTC', kind: 'bank', aliases: ['Stanbic'] },
  { id: 'standard-chartered', name: 'Standard Chartered', kind: 'bank', aliases: [] },
  { id: 'sterling', name: 'Sterling Bank', kind: 'bank', aliases: ['Sterling'] },
  { id: 'suntrust', name: 'SunTrust Bank', kind: 'bank', aliases: [] },
  { id: 'taj', name: 'TAJBank', kind: 'bank', aliases: [] },
  { id: 'titan-trust', name: 'Titan Trust Bank', kind: 'bank', aliases: [] },
  { id: 'uba', name: 'UBA', kind: 'bank', aliases: ['United Bank for Africa'] },
  { id: 'union', name: 'Union Bank', kind: 'bank', aliases: [] },
  { id: 'unity', name: 'Unity Bank', kind: 'bank', aliases: [] },
  { id: 'wema', name: 'Wema Bank', kind: 'bank', aliases: ['ALAT'] },
  { id: 'zenith', name: 'Zenith Bank', kind: 'bank', aliases: ['Zenith'] },
  { id: 'kuda', name: 'Kuda', kind: 'microfinance', aliases: ['Kuda Bank'] },
  { id: 'moniepoint', name: 'Moniepoint', kind: 'microfinance', aliases: ['Moniepoint MFB', 'TeamApt'] },
  { id: 'fairmoney', name: 'FairMoney', kind: 'microfinance', aliases: ['FairMoney MFB'] },
  { id: 'carbon', name: 'Carbon', kind: 'microfinance', aliases: ['Paylater'] },
  { id: 'vfd', name: 'VFD Microfinance Bank', kind: 'microfinance', aliases: ['VBank'] },
  { id: 'rubies', name: 'Rubies Bank', kind: 'microfinance', aliases: [] },
  { id: 'sparkle', name: 'Sparkle', kind: 'microfinance', aliases: [] },
  { id: 'opay', name: 'OPay', kind: 'wallet', aliases: ['Paycom', 'O-Pay'] },
  { id: 'palmpay', name: 'PalmPay', kind: 'wallet', aliases: ['Palm Pay'] },
  { id: 'paga', name: 'Paga', kind: 'wallet', aliases: [] },
  { id: 'chipper', name: 'Chipper Cash', kind: 'wallet', aliases: ['Chipper'] },
  { id: 'paystack', name: 'Paystack', kind: 'wallet', aliases: [] },
  { id: 'piggyvest', name: 'PiggyVest', kind: 'other', aliases: ['Piggybank'] },
  { id: 'cowrywise', name: 'Cowrywise', kind: 'other', aliases: [] },
  { id: 'risevest', name: 'Risevest', kind: 'other', aliases: ['Rise'] },
  { id: 'bamboo', name: 'Bamboo', kind: 'other', aliases: [] },
];

export function institutionList(config: AppConfig): z.input<typeof InstitutionList> {
  const c = config.cloudinary;
  const folder = c?.folder ? `${c.folder}/` : '';
  const institutions = INSTITUTIONS.map(({ logo, ...e }) => ({
    ...e,
    logoUrl:
      logo && c
        ? `https://res.cloudinary.com/${c.cloudName}/image/upload/f_auto,q_auto,w_128/${folder}institutions/${e.id}`
        : null,
  }));
  const version = createHash('sha256').update(JSON.stringify(institutions)).digest('hex').slice(0, 12);
  return { institutions, version };
}
