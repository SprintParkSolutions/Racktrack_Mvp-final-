package com.racktrack.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugins are not discovered automatically — they have to be
        // named before the bridge starts, or the JS side gets "not implemented"
        // at runtime with nothing in the build to explain why.
        registerPlugin(SnmpUdp.class);
        super.onCreate(savedInstanceState);
    }
}
