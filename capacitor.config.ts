import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.reai.app',
  appName: 'ReAi Asistanı',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    cleartext: false
  }
};

export default config;
