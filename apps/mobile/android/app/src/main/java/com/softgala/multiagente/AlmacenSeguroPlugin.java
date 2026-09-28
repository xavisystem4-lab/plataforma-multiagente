package com.softgala.multiagente;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Almacén cifrado para el refresh token y preferencias de la app.
 *
 * - La clave AES-256 se genera y vive en el Android Keystore: no se puede exportar ni leer desde la app.
 * - Cada valor se cifra con AES-GCM (IV aleatorio) y se guarda en SharedPreferences privadas.
 * - La clave del almacén se usa como dato asociado (AAD): un valor copiado a otra clave no se descifra.
 * - Solo se aceptan las claves que usa la interfaz.
 */
@CapacitorPlugin(name = "AlmacenSeguro")
public class AlmacenSeguroPlugin extends Plugin {

    private static final String ALIAS = "softgala_almacen_v1";
    private static final String PREFERENCIAS = "softgala_almacen";
    private static final int LONGITUD_IV = 12;
    private static final Set<String> CLAVES_PERMITIDAS = new HashSet<>(Arrays.asList("refreshToken", "servidor"));

    @PluginMethod
    public void obtener(PluginCall call) {
        String clave = claveValida(call);
        if (clave == null) return;
        String guardado = preferencias().getString(clave, null);
        JSObject r = new JSObject();
        if (guardado == null) {
            r.put("valor", null);
            call.resolve(r);
            return;
        }
        try {
            r.put("valor", descifrar(guardado, clave));
            call.resolve(r);
        } catch (Exception e) {
            // Valor ilegible (p. ej. la clave del Keystore se invalidó): se descarta.
            preferencias().edit().remove(clave).apply();
            r.put("valor", null);
            call.resolve(r);
        }
    }

    @PluginMethod
    public void guardar(PluginCall call) {
        String clave = claveValida(call);
        if (clave == null) return;
        String valor = call.getString("valor");
        if (valor == null || valor.length() > 4096) {
            call.reject("Valor no válido");
            return;
        }
        try {
            preferencias().edit().putString(clave, cifrar(valor, clave)).apply();
            call.resolve();
        } catch (Exception e) {
            call.reject("No se pudo cifrar el valor");
        }
    }

    @PluginMethod
    public void borrar(PluginCall call) {
        String clave = claveValida(call);
        if (clave == null) return;
        preferencias().edit().remove(clave).apply();
        call.resolve();
    }

    private String claveValida(PluginCall call) {
        String clave = call.getString("clave");
        if (clave == null || !CLAVES_PERMITIDAS.contains(clave)) {
            call.reject("Clave no permitida");
            return null;
        }
        return clave;
    }

    private SharedPreferences preferencias() {
        return getContext().getSharedPreferences(PREFERENCIAS, Context.MODE_PRIVATE);
    }

    private SecretKey claveMaestra() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(ALIAS)) {
            return ((KeyStore.SecretKeyEntry) ks.getEntry(ALIAS, null)).getSecretKey();
        }
        KeyGenerator generador = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generador.init(
            new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        );
        return generador.generateKey();
    }

    private String cifrar(String texto, String contexto) throws Exception {
        Cipher cifrador = Cipher.getInstance("AES/GCM/NoPadding");
        cifrador.init(Cipher.ENCRYPT_MODE, claveMaestra());
        cifrador.updateAAD(contexto.getBytes(StandardCharsets.UTF_8));
        byte[] iv = cifrador.getIV();
        byte[] datos = cifrador.doFinal(texto.getBytes(StandardCharsets.UTF_8));
        ByteBuffer sobre = ByteBuffer.allocate(iv.length + datos.length).put(iv).put(datos);
        return Base64.encodeToString(sobre.array(), Base64.NO_WRAP);
    }

    private String descifrar(String sobre, String contexto) throws Exception {
        byte[] bytes = Base64.decode(sobre, Base64.NO_WRAP);
        Cipher descifrador = Cipher.getInstance("AES/GCM/NoPadding");
        descifrador.init(Cipher.DECRYPT_MODE, claveMaestra(), new GCMParameterSpec(128, bytes, 0, LONGITUD_IV));
        descifrador.updateAAD(contexto.getBytes(StandardCharsets.UTF_8));
        byte[] texto = descifrador.doFinal(bytes, LONGITUD_IV, bytes.length - LONGITUD_IV);
        return new String(texto, StandardCharsets.UTF_8);
    }
}
