import claude from '../src/providers/claude.mjs';

try {
  await claude.fetch({});
  console.log('UNEXPECTED_SUCCESS');
} catch (error) {
  console.log(`REJECTED: ${error.message}`);
}
