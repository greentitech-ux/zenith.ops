plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
}

android {
  // NUNCA renomear (mesma regra do NOCZenith, CLAUDE.md §1): o applicationId
  // e a identidade do app no Android. Trocar nao atualiza - instala um app
  // SEPARADO, e cada tablet precisa de desinstalacao na mao.
  namespace = "br.com.nopulso.agente"
  compileSdk = 34

  defaultConfig {
    applicationId = "br.com.nopulso.agente"
    minSdk = 24        // Android 7: cobre tablet barato de loja
    targetSdk = 34
    // versionCode e o numero que o proprio app compara com o servidor pra
    // saber que existe versao nova (ver VERSAO_AGENTE_ANDROID no servidor).
    // Sobe JUNTO com ela, sempre - senao ninguem migra.
    versionCode = 1
    versionName = "1"
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  kotlinOptions { jvmTarget = "17" }

  // BuildConfig vem desligado por padrao no AGP 8 - e o agente usa
  // BuildConfig.VERSION_CODE pra dizer ao servidor em que versao esta
  buildFeatures { buildConfig = true }

  // ASSINATURA. A chave do release NUNCA pode mudar: o Android so aceita
  // atualizar um app por outro assinado com a MESMA chave. Chave trocada =
  // desinstalar e reinstalar em cada tablet, na mao - o mesmo estrago de
  // renomear o NOCZenith (CLAUDE.md §1).
  //
  // Por isso ela nao mora no repositorio: vem de variavel de ambiente, que no
  // CI sai de um secret do GitHub. Sem as variaveis (build local de teste), o
  // release cai na chave de debug e o APK serve pra experimentar num aparelho
  // - nunca pra distribuir na rede de lojas.
  signingConfigs {
    create("distribuicao") {
      val caminho = System.getenv("ANDROID_KEYSTORE_FILE")
      if (!caminho.isNullOrBlank()) {
        storeFile = file(caminho)
        storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
        keyAlias = System.getenv("ANDROID_KEY_ALIAS")
        keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
      }
    }
  }

  buildTypes {
    release {
      isMinifyEnabled = false
      signingConfig = if (System.getenv("ANDROID_KEYSTORE_FILE").isNullOrBlank()) {
        signingConfigs.getByName("debug")
      } else {
        signingConfigs.getByName("distribuicao")
      }
    }
  }
}

dependencies {
  implementation("androidx.core:core-ktx:1.13.1")
}
