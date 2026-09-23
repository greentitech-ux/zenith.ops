package br.com.nopulso.agente

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder

/**
 * O AGENTE PROPRIAMENTE DITO: um servico em primeiro plano que bate presenca
 * enquanto o tablet estiver ligado - com o NoPulso FECHADO, com a tela
 * apagada, e de novo sozinho depois de reiniciar.
 *
 * POR QUE PRIMEIRO PLANO (e a notificacao fixa que vem junto): e' a UNICA
 * forma no Android moderno de um processo continuar rodando sem o sistema
 * mata-lo em minutos. A notificacao nao e' enfeite - e' o preco, e o Android
 * exige que ela exista. Servico comum, JobScheduler e alarme repetido todos
 * entram em Doze e param de bater; ai a loja aparece offline sem nada ter
 * acontecido, que e' exatamente o alarme falso que este agente existe pra
 * acabar.
 *
 * CADENCIA: 25s, igual ao quiosque do navegador e ao NOCZenith. Nao e'
 * escolha estetica - o LIMIAR_OFFLINE_MS do servidor e' 90s, dimensionado
 * pra aguentar duas batidas perdidas por jitter de rede. Bater mais devagar
 * que isso faz o NOC declarar a loja fora do ar a cada oscilacao.
 *
 * CUSTO NO SERVIDOR: zero a mais. O heartbeat ja gravava espacado (PERSIST_MS,
 * ver lojaStatus.js) e a telemetria entra na mesma escrita - um tablet custa
 * o que um PC ja custava (CLAUDE.md §3).
 */
class ServicoAgente : Service() {

  companion object {
    private const val CANAL = "nopulso_agente"
    private const val ID_NOTIFICACAO = 1
    private const val INTERVALO_MS = 25_000L
    /** De quanto em quanto tempo perguntar se existe versao nova. */
    private const val INTERVALO_VERSAO_MS = 6 * 60 * 60 * 1000L

    fun ligar(ctx: Context) {
      if (!Identidade.inscrito(ctx)) return
      val intent = Intent(ctx, ServicoAgente::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        ctx.startForegroundService(intent)
      } else {
        ctx.startService(intent)
      }
    }
  }

  private var thread: HandlerThread? = null
  private var handler: Handler? = null
  private var rodando = false
  private var ultimaChecagemVersao = 0L

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    criarCanal()
    startForeground(ID_NOTIFICACAO, montarNotificacao("iniciando..."))
    val t = HandlerThread("batida-nopulso").also { it.start() }
    thread = t
    handler = Handler(t.looper)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (!rodando) {
      rodando = true
      handler?.post(laco)
    }
    // START_STICKY: se o sistema matar o servico por memoria, ele volta
    // sozinho - sem isso o tablet some do NOC e ninguem fica sabendo
    return START_STICKY
  }

  private val laco = object : Runnable {
    override fun run() {
      if (!rodando) return
      val resposta = try {
        Batida.bater(applicationContext)
      } catch (e: Exception) {
        Batida.Resposta(false, null)
      }
      atualizarNotificacao(resposta.ok)
      talvezChecarVersao()
      handler?.postDelayed(this, INTERVALO_MS)
    }
  }

  private fun talvezChecarVersao() {
    val agora = System.currentTimeMillis()
    if (agora - ultimaChecagemVersao < INTERVALO_VERSAO_MS) return
    ultimaChecagemVersao = agora
    try {
      Atualizacao.checar(applicationContext)
    } catch (e: Exception) {
      // versao nova pode esperar a proxima janela - nunca derruba a batida
    }
  }

  private fun atualizarNotificacao(ok: Boolean) {
    val texto = if (ok) {
      "Monitorando ${Identidade.unidade(applicationContext)}"
    } else {
      "Sem conexao com o NoPulso - tentando"
    }
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    nm.notify(ID_NOTIFICACAO, montarNotificacao(texto))
  }

  private fun criarCanal() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val canal = NotificationChannel(CANAL, "Agente NoPulso", NotificationManager.IMPORTANCE_LOW)
    canal.description = "Mantem o tablet visivel no NOC"
    canal.setShowBadge(false)
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    nm.createNotificationChannel(canal)
  }

  private fun montarNotificacao(texto: String): Notification {
    val abrir = PendingIntent.getActivity(
      this, 0, Intent(this, TelaPrincipal::class.java),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    )
    val construtor = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, CANAL)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this)
    }
    return construtor
      .setContentTitle("NoPulso")
      .setContentText(texto)
      .setSmallIcon(android.R.drawable.ic_menu_compass)
      .setContentIntent(abrir)
      .setOngoing(true)
      .build()
  }

  override fun onDestroy() {
    rodando = false
    handler?.removeCallbacksAndMessages(null)
    thread?.quitSafely()
    super.onDestroy()
  }
}
