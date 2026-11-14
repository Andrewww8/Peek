import { isIP } from 'node:net';
import type { ConfigContext } from 'expo/config';

export default ({ config }: ConfigContext) => {
  const value = process.env.EXPO_PUBLIC_API_URL;
  if (!value) return config;

  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (url.protocol !== 'http:' || !isIP(host)) return config;

    const infoPlist = config.ios?.infoPlist;
    const ats = infoPlist?.NSAppTransportSecurity;
    return {
      ...config,
      ios: {
        ...config.ios,
        infoPlist: {
          ...infoPlist,
          NSAppTransportSecurity: {
            ...ats,
            NSExceptionDomains: {
              ...ats?.NSExceptionDomains,
              [host]: { NSExceptionAllowsInsecureHTTPLoads: true },
            },
          },
        },
      },
    };
  } catch {
    return config;
  }
};
