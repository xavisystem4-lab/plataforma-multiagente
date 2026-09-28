package com.softgala.multiagente;

import android.os.Bundle;
import android.view.WindowManager;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Los plugins propios se registran antes de crear el puente.
        registerPlugin(AlmacenSeguroPlugin.class);
        super.onCreate(savedInstanceState);
        // Evita capturas de pantalla y que el contenido (código, diffs, tokens) aparezca en "Recientes".
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
    }
}
