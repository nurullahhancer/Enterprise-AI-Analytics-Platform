package com.reai.app;

import android.app.DownloadManager;
import android.content.Context;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.webkit.JavascriptInterface;
import android.webkit.URLUtil;
import android.widget.Toast;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        if (bridge == null || bridge.getWebView() == null) {
            return;
        }

        bridge.getWebView().addJavascriptInterface(new AndroidDownloader(), "AndroidDownloader");

        bridge.getWebView().setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            enqueueDownload(url, userAgent, contentDisposition, mimeType);
        });
    }

    private void enqueueDownload(String url, String userAgent, String contentDisposition, String mimeType) {
        try {
            String fileName = URLUtil.guessFileName(url, contentDisposition, mimeType);
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            request.setMimeType(mimeType);
            request.addRequestHeader("User-Agent", userAgent);
            request.setTitle(fileName);
            request.setDescription("Rapor indiriliyor");
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setAllowedOverMetered(true);
            request.setAllowedOverRoaming(true);

            DownloadManager manager = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (manager != null) {
                manager.enqueue(request);
                Toast.makeText(this, "Rapor Indirilenler klasorune indiriliyor", Toast.LENGTH_LONG).show();
            }
        } catch (Exception exception) {
            Toast.makeText(this, "Rapor indirilemedi", Toast.LENGTH_LONG).show();
        }
    }

    public class AndroidDownloader {
        @JavascriptInterface
        public void download(String url) {
            runOnUiThread(() -> enqueueDownload(url, null, null, "text/csv"));
        }
    }
}
