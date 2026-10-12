# FlareTune : votre bibliothèque musicale privée, sans VPS

[Essayer la démo sans connexion](https://flaretune.arcinks.com) · [Périmètre et licences (anglais)](demo.en.md). Consultez tous les paramètres en tant qu’administrateur et modifiez les préférences locales. Envoyez un message à l’assistant pour recevoir une réponse de démonstration fixe, sans appel à un modèle.

FlareTune héberge le lecteur web, le service de bibliothèque et vos fichiers musicaux dans votre propre compte Cloudflare. Importez vos fichiers audio, parcourez les titres, artistes et albums, puis écoutez sur ordinateur ou mobile. Vous n'avez pas de VPS à maintenir en fonctionnement.

Vous pouvez commencer en utilisant les quotas gratuits de Cloudflare. Cela ne garantit pas la gratuité pour toutes les collections et tous les usages : R2 Standard comprend 10 GB-month par mois, partagés entre l'audio, les pochettes et les autres fichiers ; les requêtes et le calcul ont aussi leurs limites. Les dépassements et les services d'IA facultatifs peuvent être facturés. Consultez les [tarifs officiels de R2](https://developers.cloudflare.com/r2/pricing/) et le [guide d'installation en anglais](https://github.com/arctan303/FlareTune/blob/main/guide/deployment.en.md).

## Essayer la démo

La démo publique permet de découvrir l'interface et d'écouter une sélection autorisée. Vous pouvez conserver des favoris dans **ce navigateur**, sans vous connecter. Ces données ne sont pas enregistrées sur le serveur et ne sont pas synchronisées avec d'autres appareils ; leur suppression dans le navigateur peut les faire disparaître. Les fonctions d'administration sont présentées sans permettre de modifications.

Votre propre installation fonctionne autrement : les membres se connectent et leurs favoris ainsi que leurs listes personnelles sont rattachés à leur compte. La démo ne permet pas de vérifier la synchronisation des données d'un même compte entre appareils. L'historique local de lecture ne doit pas non plus être confondu avec les favoris et listes enregistrés sur le serveur.

## Créer votre bibliothèque

1. Préparez un compte Cloudflare et activez R2 en suivant les exigences de souscription affichées dans son tableau de bord. Le déploiement utilise aussi un compte GitHub ou GitLab. Aucun VPS n'est nécessaire.
2. Ouvrez [Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/arctan303/FlareTune). Le parcours configure le Worker, D1 et un bucket R2 privé dans votre compte.
3. Saisissez et conservez un `SETUP_SECRET` aléatoire d'au moins 32 caractères. Ne le partagez pas : il sert à revendiquer l'installation et à protéger ses secrets ; ce n'est pas votre mot de passe de connexion.
4. Une fois le déploiement terminé, ouvrez l'adresse de l'instance, vérifiez `SETUP_SECRET` et créez le premier administrateur avec un mot de passe d'au moins 8 caractères.
5. Connectez-vous et importez quelques morceaux depuis la page d'importation. Pour une collection stockée dans des dossiers, consultez le [guide de l'outil d'importation en anglais](https://github.com/arctan303/FlareTune/blob/main/tooling/ingest-agent/README.en.md).

La nouvelle bibliothèque est vide. FlareTune ne fournit pas automatiquement les fichiers audio que vous n'avez pas importés. Utilisez des morceaux, pochettes et paroles que vous avez le droit d'utiliser.

## Commencer à écouter

Recherchez un titre, un artiste ou un album ; lancez un morceau et ouvrez le lecteur en plein écran. Choisissez la présentation classique ou les photographies de l'artiste. Lorsqu'elles sont disponibles, les paroles peuvent afficher l'original et la traduction synchronisés ; tous les morceaux ne disposent pas de paroles ou d'un minutage mot à mot.

Ajoutez des morceaux aux favoris et créez vos listes. L'administrateur entretient la collection commune et crée les comptes des membres ; chacun gère ses listes personnelles. L'assistant musical est facultatif et nécessite la configuration d'un fournisseur d'IA. La lecture fonctionne sans lui.

Vous pouvez activer Subsonic dans vos paramètres personnels pour utiliser un client compatible. Le serveur lit le fichier original sans transcodage en temps réel. La compatibilité, le téléchargement et l'écoute hors ligne dépendent du client et du format ; consultez les fonctions effectivement vérifiées dans le guide.

## Pour aller plus loin

Cette page constitue une introduction. Les guides complets restent disponibles en anglais :

- [Utilisation et fonctions](https://github.com/arctan303/FlareTune/blob/main/guide/using-flaretune.en.md)
- [Installation et mises à jour](https://github.com/arctan303/FlareTune/blob/main/guide/deployment.en.md)
- [Administration et maintenance](https://github.com/arctan303/FlareTune/blob/main/guide/administration.en.md)
- [Clients Subsonic et limites de compatibilité](https://github.com/arctan303/FlareTune/blob/main/guide/subsonic.en.md)

Avant une mise à jour, conservez des sauvegardes récupérables de D1 et R2. N'utilisez pas l'initialisation d'une nouvelle installation pour écraser une instance existante.
