package br.com.nopulso.agente

import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URI
import java.io.InputStream
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** Prova local idêntica à do Windows. Nunca escuta na rede da loja. */
class ValidadorLocal(private val identidade: () -> Dados, private val porta: Int = 17841) {
  data class Dados(val origem: String, val codigo: String, val posto: String, val token: String)
  @Volatile private var servidor: ServerSocket? = null
  @Volatile private var trabalhador: Thread? = null
  val portaAtiva: Int get() = servidor?.localPort ?: -1

  @Synchronized fun iniciar() {
    if (trabalhador?.isAlive == true) return
    val socket = try { ServerSocket(porta, 8, InetAddress.getByName("127.0.0.1")) } catch (_: Exception) { return }
    servidor = socket
    trabalhador = Thread({
      try {
        while (!socket.isClosed) {
          try { socket.accept().use { atender(it) } } catch (_: Exception) { }
        }
      } finally { socket.close() }
    }, "noc-validacao-local").apply { isDaemon = true; start() }
  }
  @Synchronized fun parar() { servidor?.close(); servidor = null }

  private fun linha(input: InputStream): String {
    val b = StringBuilder()
    while (b.length < 2048) {
      val n = input.read()
      if (n < 0) throw IllegalArgumentException("Fim da conexão")
      if (n == 10) return b.toString().trimEnd('\r')
      if (n > 127) throw IllegalArgumentException("Cabeçalho inválido")
      b.append(n.toChar())
    }
    throw IllegalArgumentException("Linha muito longa")
  }
  private fun atender(socket: Socket) {
    socket.soTimeout = 2500
    val input = socket.getInputStream()
    val pedido = linha(input)
    val headers = mutableMapOf<String, String>()
    var total = 0
    while (true) {
      val l = linha(input); total += l.length
      require(total <= 8192)
      if (l.isEmpty()) break
      val partes = l.split(':', limit = 2)
      require(partes.size == 2)
      val nome = partes[0].lowercase(java.util.Locale.ROOT)
      require(!headers.containsKey(nome))
      headers[nome] = partes[1].trim()
    }
    val d = identidade()
    val uri = URI(d.origem)
    val origem = if (uri.scheme == "https" && uri.host != null && uri.rawUserInfo == null) {
      "https://" + uri.host + (if (uri.port >= 0) ":${uri.port}" else "")
    } else ""
    var status = "403 Forbidden"
    var corpo = "{}"
    var cors = ""
    if (origem.isNotEmpty() && headers["origin"] == origem && headers["host"] == "127.0.0.1:${socket.localPort}" && d.codigo.isNotBlank() && d.posto.isNotBlank() && d.token.isNotBlank()) {
      cors = "Access-Control-Allow-Origin: $origem\r\nAccess-Control-Allow-Methods: POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\nAccess-Control-Allow-Private-Network: true\r\n"
      if (pedido == "OPTIONS /validar HTTP/1.1") { status = "204 No Content"; corpo = "" }
      else if (pedido == "POST /validar HTTP/1.1" && headers["content-type"]?.startsWith("application/json") == true && !headers.containsKey("transfer-encoding")) {
        val tamanho = headers["content-length"]?.toIntOrNull() ?: 0
        require(tamanho in 1..4096)
        val bytes = ByteArray(tamanho)
        var lidos = 0
        while (lidos < tamanho) { val n = input.read(bytes, lidos, tamanho-lidos); require(n > 0); lidos += n }
        val desafio = Regex("""^\s*\{\s*"desafio"\s*:\s*"([A-Za-z0-9_.-]{32,2048})"\s*\}\s*$""").matchEntire(String(bytes, Charsets.UTF_8))?.groupValues?.get(1)
        require(desafio != null)
        val hmac = Mac.getInstance("HmacSHA256")
        hmac.init(SecretKeySpec(d.token.toByteArray(Charsets.UTF_8), "HmacSHA256"))
        val assinatura = hmac.doFinal("noc-local\n$origem\n$desafio".toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it.toInt() and 255) }
        corpo = "{\"codigo\":${json(d.codigo)},\"posto\":${json(d.posto)},\"assinatura\":\"$assinatura\"}"
        status = "200 OK"
      }
    }
    val bytes = corpo.toByteArray(Charsets.UTF_8)
    val head = "HTTP/1.1 $status\r\n${cors}Cache-Control: no-store\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n"
    socket.getOutputStream().apply { write(head.toByteArray(Charsets.US_ASCII)); write(bytes); flush() }
  }
  private fun json(valor: String): String = "\"" + valor.map { c ->
    when(c) { '\\' -> "\\\\"; '"' -> "\\\""; else -> if(c.code < 32) "\\u%04x".format(c.code) else c.toString() }
  }.joinToString("") + "\""
}
