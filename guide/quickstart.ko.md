# FlareTune 빠른 시작

[로그인 없이 온라인 데모 체험](https://flaretune.arcinks.com) · [체험 범위와 콘텐츠 라이선스(영어)](demo.en.md). 관리자 화면의 전체 설정을 살펴보고 로컬 환경설정을 변경할 수 있습니다. 도우미에게 메시지를 보내면 모델 호출 없이 고정된 데모 답변을 받습니다.

[한국어](quickstart.ko.md) · [English](../README.en.md) · [简体中文](../README.md)

VPS 관리 없이 Cloudflare에서 나만의 비공개 음악 라이브러리를 만드세요. 앱은 Workers, 메타데이터는 D1, 오디오와 커버는 비공개 R2에 저장됩니다. R2 Standard는 매월 10 GB-month 무료 사용량을 제공합니다. 계정 전체 사용량, 요청 수 및 선택적 서비스에 따라 요금이 발생할 수 있으니 [비용 안내(영어)](deployment.en.md)를 확인하세요.

먼저 [로그인 없는 데모](demo.en.md)에서 재생, 검색, 즐겨찾기와 재생목록을 체험하세요. 개인 데이터는 현재 브라우저에만 저장됩니다.

1. Cloudflare 계정에서 R2를 활성화한 후 [Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/arctan303/FlareTune)로 리소스를 만드세요.
2. 최소 32자의 무작위 `SETUP_SECRET`을 설정하고 안전하게 보관하세요.
3. 배포 주소를 열어 비밀값을 확인하고 첫 관리자 계정을 만든 후 로그인하세요.
4. 사용할 권한이 있는 음악을 가져오세요. 파일이 많다면 [로컬 가져오기 도구(영어)](../tooling/ingest-agent/README.en.md)를 사용할 수 있습니다.

개인 설정에서 한국어를 선택할 수 있습니다. 일반 인스턴스의 즐겨찾기와 재생목록은 계정에 저장되지만 재생 기록은 현재 브라우저에만 남습니다. AI는 선택 사항입니다. 업데이트 전 D1과 R2를 백업하고, 새 설치 초기화로 기존 인스턴스를 덮어쓰지 마세요.

자세한 안내(영어): [사용](using-flaretune.en.md) · [배포](deployment.en.md) · [관리](administration.en.md) · [Subsonic](subsonic.en.md).
