package br.com.nopulso.agente

import android.content.Context
import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL

/**
 * A BATIDA DE PRESENCA.
 *
 * Bate no MESMO /api/loja-status/heartbeat que o quiosque do navegador e o
 * NOCZenith ja usam. Nenhuma rota nova: o servidor nao precisa saber que
 * existe um agente Android, e por isso tudo que ja existe (card do NOC,
 * aviso de bateria, alerta de loja offline, mensagem do Suporte pro
 * computador) funciona de primeira.
 *
 * SEM BIBLIOTECA DE REDE: HttpURLConnection e org.json vem no proprio
 * Android. Um APK sem dependencia e um APK que compila em 2026 e continua
 * compilando em 2029 - e que baixa rapido no 4G de uma loja.
 */
object Batida {

  /** Latencia da batida anterior; cada medida viaja uma vez so. */
  private var ultimaLatenciaMs: Long? = null
  private var falhasSeguidas = 0
  private var abertoDesde = System.currentTimeMillis()

  /** Resposta do servidor que interessa ao agente. */
  data class Resposta(val ok: Boolean, val corpo: JSONObject?)

  fun bater(ctx: Context): Resposta {
    val unidade = Identidade.unidade(ctx)
    if (unidade.isBlank()) return Resposta(false, null)

    val corpo = JSONObject()
      .put("unidade", unidade)
      .put("userAgent", Telemetria.userAgent())
      .put("abertoDesde", abertoDesde)
      .put("aparelho", Telemetria.montar(ctx))
    val posto = Identidade.posto(ctx)
    if (posto.isNotBlank()) corpo.put("posto", posto)
    val token = Identidade.token(ctx)
    if (token.isNotBlank()) corpo.put("token", token)

    // medicao de link, igual a do quiosque: o tempo da propria batida JA e a
    // latencia real de ponta a ponta, do jeito que o sistema e usado
    val rede = JSONObject().put("falhasSeguidas", falhasSeguidas)
    ultimaLatenciaMs?.let { rede.put("latenciaMs", it) }
    ultimaLatenciaMs = null
    corpo.put("rede", rede)

    val comecou = System.currentTimeMillis()
    return try {
      val resposta = postar(Identidade.base(ctx) + "/api/loja-status/heartbeat", corpo, token)
      ultimaLatenciaMs = System.currentTimeMillis() - comecou
      falhasSeguidas = 0
      Resposta(true, resposta)
    } catch (e: Exception) {
      // sem rede agora - a proxima batida tenta de novo, e o contador conta
      // quantas nao passaram (o servidor le isso pra saber que a maquina
      // estava viva tentando durante o silencio)
      falhasSeguidas++
      Resposta(false, null)
    }
  }

  private fun postar(endereco: String, corpo: JSONObject, token: String): JSONObject? {
    val conexao = (URL(endereco).openConnection() as HttpURLConnection).apply {
      requestMethod = "POST"
      connectTimeout = 15000
      readTimeout = 15000
      doOutput = true
      setRequestProperty("Content-Type", "application/json; charset=utf-8")
      if (token.isNotBlank()) setRequestProperty("x-noc-token", token)
    }
    try {
      conexao.outputStream.use { it.write(corpo.toString().toByteArray(Charsets.UTF_8)) }
      if (conexao.responseCode !in 200..299) throw Exception("HTTP ${conexao.responseCode}")
      val texto = conexao.inputStream.bufferedReader().use(BufferedReader::readText)
      return if (texto.isBlank()) null else JSONObject(texto)
    } finally {
      conexao.disconnect()
    }
  }

  /** GET simples, usado pela checagem de versao. */
  fun pegarJson(endereco: String): JSONObject? {
    val conexao = (URL(endereco).openConnection() as HttpURLConnection).apply {
      requestMethod = "GET"
      connectTimeout = 15000
      readTimeout = 15000
    }
    try {
      if (conexao.responseCode !in 200..299) return null
      val texto = conexao.inputStream.bufferedReader().use(BufferedReader::readText)
      return if (texto.isBlank()) null else JSONObject(texto)
    } catch (e: Exception) {
      return null
    } finally {
      conexao.disconnect()
    }
  }
}
