import { getApiUrl } from './api';
import { Capacitor } from '@capacitor/core';

export const APK_DOWNLOAD_PATH = '/downloads/reai-asistani-latest.apk';

export const getApkDownloadUrl = (): string => getApiUrl(APK_DOWNLOAD_PATH);

export const shouldShowApkDownload = (): boolean => Capacitor.getPlatform() === 'web';
