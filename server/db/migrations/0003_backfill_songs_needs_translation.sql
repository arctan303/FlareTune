-- Migration number: 0003 2026-07-30T14:40:00.000Z
-- Backfill databases that applied 0002 before the translation flags were added.
UPDATE Songs SET needs_translation = 1 WHERE id IN (
  '349d38c908d5841e', '882cf4cdbb813aa9', 'dc4785cc33af1487', 'fd910d4d4172c5e5',
  '240345d1574b577f', 'aa7d8d61095874cf', '7cf8327b1cdc7fa0', '7f962e59358b21e5',
  '7f6ee182dcfbae6e', '2e293cab9c813f65', '2ac1796a18a8e07f', '236be2057a06d25c',
  '9b3214190b6d01ed', '4d39c7de9f6ecc80', 'c60fc992a9d1c4e6', '20a9060c8ec029ce',
  '41c57257379144ed', '33a97249cf6fef81', '18f04cb2758eb171', '584a3c7033a00a6d',
  'b26cd9eae77ab186', '5de784e188129e0f', '63dafd49baa2b83b', '8eac35d2c367a62d',
  'cc45cac5689ad50f', '038dc0e1f7152865', '4836ba78a4c154f0', 'dce217ebb7dd40ab',
  '5354942a00b1d319', 'c37aebf42cde8f99', '4f8dab16c668328a', '53f548b93dffb2f4',
  'e965feba00ea69d5', '71477d5629a301c7', 'b5fb321a00ff0576', '1b3eef1e8ccebf4b',
  '6f458419c9169d41', '38bb42d8bcc39f83', 'beaf89f119e7d5b9', '40eff202e02b45d8',
  '6eab21428889a6fb', '12145e2fad7706a7', '3feed47eee299603', 'f7c69fdd169c3aee',
  '81921ebc987f8d94', '0c635e0236704e23', 'c52b0b56522a4502', '46ad804038c57dc0',
  '30ef5cd2d49adf43', '0f3c637aa2bfd0e7', '551d3a80e583dab7', 'b8389183094d800f',
  '36df0f0d0841c3ef', '704c9768838f72ba', '3d86be38f7184ce2', '33beca9a3b48f637',
  'f98d7f18e0424dc6', '7463dc1f737da145', 'f87089f76111c931', '217ade82845778a9',
  'dda7bfb727d86a7b', '74ed1353ef3cce46', 'fc2f4b8c32bdf8d6', 'fad8b66e6e00aa7e',
  'ac5af4364c3e00ee', '6a4d1fffc2ffbc1d', 'db20e9579b7b9e2c', '3048ba1555b56164',
  '0add6d2daaa20ce6', '0b766af039acd5cd', '752479e7d669bc00', '9dc4af1b3f42dc7e',
  '45d4864042d95d7b', '124b492bf4f270ee', '167bbafaba08ca19', '1c057d42bb0fde5c',
  '2d8299932ed236c9', 'c536a132c56f8e40', 'de6e9db14b0bb100', '051d895a69eaa406',
  'fc128653f2ec2de1', '5bf7681eb0a50590', '542eed87403f05d5', 'f1646db6a59c9281',
  '1bc907ffaaded2b2', '081f08f02139102b', '3edcc30bcae4b94d', '0500872ab7b58e8b',
  '8dd2e1e9b7e40b32', 'eca81f8e2d022e11', '72166b01aaba3a37', '7fe854e6490b7f41',
  '763e774f02375440', '55ee67a04668de57', '714bc1a69c840b18', '24cc18a80bf97659',
  '6c36f1dab08bc6de', 'da8ab9a99e85217a'
);
