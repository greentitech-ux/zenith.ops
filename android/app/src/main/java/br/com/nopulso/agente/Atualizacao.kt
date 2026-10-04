package br.com.nopulso.agente

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import org.json.JSONObject

/**
 * EXISTE VERSAO NOVA?
 *
 * Mesma ideia do VERSAO_VIGIA do NOCZenith (CLAUDE.md §4 item 2): o agente
 * pergunta a versao ao servidor, ve um numero maior que o seu e migra. A
 * diferenca e' honesta e vale ser dita: no Windows o script se sobrescreve
 * sozinho; no Android, NAO da - instalar um APK por conta propria exige
 * privilegio de Device Owner (o aparelho provisionado como corporativo).
 *
 * Entao aqui o agente faz o que pode sem privilegio nenhum: avisa. Uma
 * notificacao que abre o download, e alguem toca "instalar" uma vez. Se um
 * dia os tablets forem provisionados como Device Owner, a instalacao passa a
 * poder ser silenciosa - e so este arquivo muda.
 *
 * A versao instalada NAO precisa de campo novo no servidor: ela ja viaja no
 * userAgent de toda batida ("NoPulsoAgente/3 (...)"), que o NOC ja mostra no
 * card do computador. Menos um lugar pra divergir.
 */
object Atualizacao {
  private const val CANAL = "nopulso_atualizacoes"
  private const val ID_NOTIFICACAO = 2

  fun checar(ctx: Context) {
    val resposta = Batida.pegarJson(
      Identidade.base(ctx) + "/api/loja-status/agente-android/versao"
    ) ?: return
    receber(ctx, resposta)
  }

  fun receber(ctx: Context, resposta: JSONObject) {
    val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    val disponivel = resposta.optInt("versao", 0)
    if (disponivel > 0 && disponivel <= BuildConfig.VERSION_CODE) nm.cancel(ID_NOTIFICACAO)
    val prefs = ctx.getSharedPreferences("nopulso_atualizacoes", Context.MODE_PRIVATE)
    val avisada = prefs.getInt("versao_avisada", 0)
    val url = resposta.optString("url", "")
    if (!RegraAtualizacao.deveAvisar(BuildConfig.VERSION_CODE, disponivel, avisada, url)) return
    // Não marcar como avisado se o Android ainda bloqueia as notificações.
    if (!nm.areNotificationsEnabled()) return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      nm.createNotificationChannel(NotificationChannel(CANAL, "Atualizações NoPulso", NotificationManager.IMPORTANCE_DEFAULT))
      if (nm.getNotificationChannel(CANAL)?.importance == NotificationManager.IMPORTANCE_NONE) return
    }
    avisar(ctx, disponivel, url)
    prefs.edit().putInt("versao_avisada", disponivel).apply()
  }

  private fun avisar(ctx: Context, versao: Int, url: String) {
    val abrir = PendingIntent.getActivity(
      ctx, 0, Intent(Intent.ACTION_VIEW, Uri.parse(url)),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    )
    val construtor = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(ctx, CANAL)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(ctx)
    }
    val notificacao = construtor
      .setContentTitle("Atualizacao do agente NoPulso")
      .setContentText("Versao $versao disponivel - toque para instalar")
      .setSmallIcon(android.R.drawable.stat_sys_download)
      .setContentIntent(abrir)
      .setAutoCancel(true)
      .build()
    val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    nm.notify(ID_NOTIFICACAO, notificacao)
  }
}
