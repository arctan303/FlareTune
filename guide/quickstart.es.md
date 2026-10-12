# FlareTune: tu biblioteca musical privada, sin VPS

[Prueba la demo sin iniciar sesión](https://flaretune.arcinks.com) · [Alcance y licencias (inglés)](demo.en.md). Explora todos los ajustes como administrador y cambia tus preferencias locales. Puedes enviar mensajes al asistente y recibir una respuesta fija de demostración, sin llamar a un modelo.

FlareTune reúne el reproductor web, el servicio de la biblioteca y el almacenamiento de música en tu propia cuenta de Cloudflare. Importa tus archivos de audio, explora canciones, artistas y álbumes, y escucha desde el ordenador o el móvil. No necesitas mantener un VPS encendido.

Puedes empezar aprovechando las cuotas gratuitas de Cloudflare. Esto no garantiza un coste cero para cualquier colección o uso: R2 Standard incluye 10 GB-month al mes, compartidos por el audio, las portadas y los demás archivos; también existen límites de solicitudes y de cómputo. El exceso y los servicios de IA opcionales pueden generar cargos. Consulta las [tarifas oficiales de R2](https://developers.cloudflare.com/r2/pricing/) y la [guía de instalación en inglés](https://github.com/arctan303/FlareTune/blob/main/guide/deployment.en.md).

## Probar la demo

La demo pública sirve para conocer la interfaz y escuchar una selección autorizada. Puedes guardar favoritos en **este navegador**, sin iniciar sesión. Esos datos no se guardan en el servidor ni se sincronizan con otros dispositivos; al borrar los datos del sitio puedes perderlos. Las funciones de administración se muestran sin permitir cambios.

Una instalación propia funciona de otra manera: los miembros inician sesión y sus favoritos y listas personales pertenecen a su cuenta. La demo no permite comprobar la sincronización de los datos de una misma cuenta entre dispositivos. El historial de reproducción local tampoco debe confundirse con los favoritos y las listas guardados en el servidor.

## Crear tu biblioteca

1. Prepara una cuenta de Cloudflare y activa R2 siguiendo los requisitos de contratación que muestre su panel. El flujo de despliegue también utiliza una cuenta de GitHub o GitLab. No necesitas contratar un VPS.
2. Abre [Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/arctan303/FlareTune). El flujo configura el Worker, D1 y un bucket R2 privado en tu cuenta.
3. Introduce y conserva un `SETUP_SECRET` aleatorio de al menos 32 caracteres. No lo compartas: sirve para reclamar la instalación y proteger secretos de la instancia; no es tu contraseña de acceso.
4. Al terminar el despliegue, abre la dirección de la instancia, verifica `SETUP_SECRET` y crea el primer administrador con una contraseña de al menos 8 caracteres.
5. Inicia sesión e importa unas pocas canciones desde la página de importación. Para colecciones en carpetas, consulta la [herramienta de importación en inglés](https://github.com/arctan303/FlareTune/blob/main/tooling/ingest-agent/README.en.md).

La biblioteca nueva está vacía. FlareTune no suministra automáticamente el audio que no hayas importado. Utiliza música, portadas y letras que tengas derecho a usar.

## Empezar a escuchar

Busca un título, artista o álbum; reproduce una canción y abre el reproductor a pantalla completa. Puedes elegir la vista clásica o las fotografías del artista. Las letras disponibles pueden mostrar el original y la traducción sincronizados; no todas las canciones tienen letras o tiempos por palabra.

Marca canciones como favoritas y crea tus listas. El administrador mantiene la colección compartida y crea las cuentas de los miembros; cada miembro gestiona sus propias listas. El asistente musical es opcional y requiere un proveedor de IA configurado. La reproducción funciona sin él.

Puedes activar Subsonic en tu configuración personal para utilizar clientes compatibles. El servidor reproduce el archivo original y no realiza transcodificación en tiempo real. La compatibilidad, la descarga y la reproducción sin conexión dependen del cliente y del formato; consulta el alcance verificado en la guía.

## Más ayuda

Esta página es una introducción. Las instrucciones completas todavía están disponibles en inglés:

- [Uso y funciones](https://github.com/arctan303/FlareTune/blob/main/guide/using-flaretune.en.md)
- [Instalación y actualizaciones](https://github.com/arctan303/FlareTune/blob/main/guide/deployment.en.md)
- [Administración y mantenimiento](https://github.com/arctan303/FlareTune/blob/main/guide/administration.en.md)
- [Clientes Subsonic y límites de compatibilidad](https://github.com/arctan303/FlareTune/blob/main/guide/subsonic.en.md)

Antes de actualizar, conserva copias recuperables de D1 y R2. No reutilices la inicialización de una instalación nueva para sobrescribir una instancia existente.
