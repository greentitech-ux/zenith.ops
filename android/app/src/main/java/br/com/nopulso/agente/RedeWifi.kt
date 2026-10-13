package br.com.nopulso.agente

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.wifi.WifiManager
import androidx.core.content.ContextCompat
import org.json.JSONObject

/**
 * O QUE O TABLET SABE DA REDE WI-FI em que esta: nome (SSID), sinal, frequencia
 * e velocidade do link. E' o que o navegador NUNCA conta (privacidade) e o
 * Master pediu na ficha do NOC: "o nome da rede atual seria bom tambem".
 *
 * O PRECO: o Android trata o SSID como dado de LOCALIZACAO. Sem a permissao
 * de localizacao concedida (e a localizacao ligada no aparelho), o sistema
 * devolve "<unknown ssid>" e sinal nenhum. Por isso:
 *  - a TelaPrincipal pede a permissao uma vez, junto com a de notificacao;
 *  - o ServicoAgente so se declara "location" quando a permissao existe
 *    (declarar sem ter e' SecurityException no Android 14);
 *  - aqui, sem permissao, devolve null - e o heartbeat segue igual ao de
 *    antes. Permissao negada nunca derruba o monitoramento.
 *
 * Campo que o Android nao responder simplesmente nao vai (CLAUDE.md §6).
 */
object RedeWifi {
  const val SSID_DESCONHECIDO = "<unknown ssid>"

  fun temPermissaoDeLocalizacao(ctx: Context): Boolean =
    ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_FINE_LOCATION) ==
      PackageManager.PERMISSION_GRANTED

  /**
   * Le a associacao Wi-Fi atual. null quando nao ha permissao, nao esta em
   * Wi-Fi, ou o Android escondeu o nome (localizacao desligada).
   */
  fun ler(ctx: Context): JSONObject? {
    if (!temPermissaoDeLocalizacao(ctx)) return null
    return try {
      val wm = ctx.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
        ?: return null
      // connectionInfo esta "deprecated" desde o Android 12, mas continua
      // sendo o unico jeito sincrono de ler o SSID com a permissao em maos;
      // o substituto (NetworkCallback com FLAG_INCLUDE_LOCATION_INFO) e'
      // assincrono e nao cabe numa batida de 25s.
      @Suppress("DEPRECATION")
      val info = wm.connectionInfo ?: return null
      val saida = JSONObject()
      limparSsid(info.ssid)?.let { saida.put("nome", it) }
      // -127 = "sem leitura" em alguns chips; 0 nunca e' um RSSI real
      if (info.rssi < 0 && info.rssi > -127) saida.put("sinal", sinalPorcento(info.rssi))
      if (info.frequency > 0) saida.put("frequenciaMhz", info.frequency)
      if (info.linkSpeed > 0) saida.put("linkMbps", info.linkSpeed)
      if (saida.length() > 0) saida else null
    } catch (e: Exception) {
      null
    }
  }

  /** O Android devolve o SSID entre aspas, ou "<unknown ssid>"/"0x..." quando esconde. */
  fun limparSsid(bruto: String?): String? {
    val s = bruto?.trim()?.removeSurrounding("\"")?.trim() ?: return null
    if (s.isEmpty() || s == SSID_DESCONHECIDO || s.startsWith("0x")) return null
    return s.take(80)
  }

  /**
   * RSSI (dBm) em % - a MESMA regua do netsh do Windows e do calculateSignalLevel
   * classico do Android: -100 dBm = 0%, -55 dBm = 100%. Fixa aqui (e nao no
   * calculateSignalLevel do sistema) porque a do sistema mudou de curva no
   * Android 11 e varia por fabricante: a ficha do NOC compara tablet com PC.
   */
  fun sinalPorcento(rssi: Int): Int {
    val v = ((rssi + 100) * 100.0 / 45.0).toInt()
    return v.coerceIn(0, 100)
  }
}
