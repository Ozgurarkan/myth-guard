package com.mythguard.player;

import com.getcapacitor.BridgeActivity;
import android.webkit.WebSettings;

public class MainActivity extends BridgeActivity {
    @Override
    public void onStart() {
        super.onStart();
        // Game hosts commonly use http://LAN-IP. Permit this explicit player
        // app to reach the host while Android keeps cleartext disabled elsewhere.
        getBridge().getWebView().getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
    }
}
