package br.com.nopulso.agente

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.StatFs
import org.json.JSONObject

/**
 * O QUE O APARELHO SABE DE SI, no formato que o servidor ja aceita.
 *
 * O formato e' EXATAMENTE o de public/aparelho.js (o quiosque no navegador):
 * mesmo `aparelho` dentro do mesmo heartbeat, mesma lista fechada do
 * sanitizarAparelho() no servidor. Assim o card do NOC, o aviso de bateria e
 * o alerta na Central funcionam sem UMA linha nova de servidor - e um tablet
 * com agente aparece do lado dos 52 PCs, na mesma tela.
 *
 * O que o agente sabe e o navegador nao sabia:
 *  - bateria em aparelho Android sem Chrome, e mesmo com a tela apagada;
 *  - o armazenamento do APARELHO inteiro, nao a cota do navegador.
 *
 * Campo que o Android nao responder simplesmente nao vai - nunca um numero
 * inventado (mesma regra do coletor do navegador, e do CLAUDE.md §6).
 */
object Telemetria {

  fun montar(ctx: Context): JSONObject {
    val aparelho = JSONObject()
    bateria(ctx)?.let { aparelho.put("bateria", it) }
    armazenamento()?.let { aparelho.put("armazenamento", it) }
    rede(ctx)?.let { aparelho.put("rede", it) }
    aparelho.put("so", sistema())
    aparelho.put("toque", true)
    return aparelho
  }

  private fun bateria(ctx: Context): JSONObject? {
    val estado: Intent = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
      ?: return null
    val nivel = estado.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
    val escala = estado.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
    if (nivel < 0 || escala <= 0) return null
    val status = estado.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
    val carregando = status == BatteryManager.BATTERY_STATUS_CHARGING ||
      status == BatteryManager.BATTERY_STATUS_FULL
    return JSONObject()
      .put("porcento", Math.round(nivel * 100f / escala))
      .put("carregando", carregando)
  }

  private fun armazenamento(): JSONObject? {
    return try {
      val fs = StatFs(Environment.getDataDirectory().path)
      val totalBytes = fs.totalBytes
      if (totalBytes <= 0L) return null
      val usadoBytes = totalBytes - fs.availableBytes
      val gb = 1073741824.0
      val totalGb = arredondar(totalBytes / gb)
      val usadoGb = arredondar(usadoBytes / gb)
      JSONObject()
        .put("totalGb", totalGb)
        .put("usadoGb", usadoGb)
        .put("usadoPct", Math.round(usadoBytes * 100.0 / totalBytes).toInt())
    } catch (e: Exception) {
      null
    }
  }

  private fun rede(ctx: Context): JSONObject? {
    return try {
      val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        ?: return null
      val ativa = cm.activeNetwork ?: return null
      val caps = cm.getNetworkCapabilities(ativa) ?: return null
      val saida = JSONObject()
      when {
        caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> saida.put("tipo", "wifi")
        caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> saida.put("tipo", "cellular")
        caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> saida.put("tipo", "ethernet")
        else -> saida.put("tipo", "outro")
      }
      val kbps = caps.linkDownstreamBandwidthKbps
      if (kbps > 0) saida.put("downlinkMbps", arredondar(kbps / 1000.0))
      saida
    } catch (e: Exception) {
      null
    }
  }

  private fun sistema(): JSONObject = JSONObject()
    .put("nome", "Android")
    .put("versao", Build.VERSION.RELEASE ?: "")
    .put("movel", true)

  /** Duas casas, igual ao coletor do navegador. */
  private fun arredondar(v: Double): Double = Math.round(v * 100.0) / 100.0

  /**
   * O modelo do aparelho viaja no userAgent, que o NOC ja mostra ("resumo do
   * dispositivo" em loja-status.html). Formato parecido com o de um navegador
   * Android pra tela nao precisar de caso especial.
   */
  fun userAgent(): String =
    "NoPulsoAgente/${BuildConfig.VERSION_CODE} (Linux; Android ${Build.VERSION.RELEASE}; " +
      "${Build.MANUFACTURER} ${Build.MODEL})"
}
