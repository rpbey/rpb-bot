import { mkdir, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';

import { prisma } from './prisma.js';

const __dirname = import.meta.dir;

const COMMAND_TEMPLATE = (
  name: string,
  description: string,
  response: string,
) => `
import { CommandInteraction } from 'discord.js';
import { Discord, Slash } from '@rpbey/discordx';

@Discord()
export class ${name.replace(/[^a-zA-Z0-9]/g, '')}Command {
  @Slash({ name: '${name}', description: '${description.replace(/'/g, "\\'")}' })
  async chatInputRun(interaction: CommandInteraction) {
    const response = \`${response.replace(/`/g, '\\`').replace(/\${/g, '\\${')}\`;

    // Check if response is JSON (simple check)
    if (response.trim().startsWith('{')) {
      try {
        const json = JSON.parse(response);
        return interaction.reply(json);
      } catch {
        // Fallback to text
      }
    }
    return interaction.reply({ content: response });
  }
}
`;

export async function generateCustomCommands() {
  const isProd = process.env.NODE_ENV === 'production';

  const srcDir = path.resolve(__dirname, '../../src/commands/Custom');
  const distDir = path.resolve(__dirname, '../commands/Custom');

  console.log('Generating custom commands...');

  try {
    const _targetDir = srcDir;

    const srcExists = await Bun.file(path.join(srcDir, '..'))
      .exists()
      .catch(() => false);
    if (!srcExists && isProd) {
      console.log(
        'Production mode: skipping custom command generation (src not found).',
      );
      return;
    }

    try {
      await mkdir(srcDir, { recursive: true });
    } catch {
      if (isProd) {
        console.log(
          'Production mode: skipping custom command generation (src not found).',
        );
        return;
      }
    }

    // Clear existing commands in src
    const existingFiles = await readdir(srcDir);
    for (const file of existingFiles) {
      if (file.endsWith('.ts')) {
        await unlink(path.join(srcDir, file));
      }
    }

    const commands = await prisma.botCommand.findMany({
      where: { enabled: true },
    });

    // Get list of existing hardcoded commands to avoid duplicates
    const hardcodedDirs = [
      'Beyblade',
      'General',
      'Moderation',
      'Admin',
      'Music',
      'Voice',
    ];
    const hardcodedCommands = new Set<string>();

    for (const dir of hardcodedDirs) {
      try {
        const dirPath = path.resolve(__dirname, '../commands', dir);
        const files = await readdir(dirPath);
        for (const file of files) {
          if (file.endsWith('.ts') || file.endsWith('.js')) {
            const content = await Bun.file(path.join(dirPath, file)).text();
            const match = content.match(/name:\s*['"]([^'"]+)['"]/);
            if (match?.[1]) {
              hardcodedCommands.add(match[1].toLowerCase());
            } else {
              const filename = file.split('.')[0];
              if (filename) {
                hardcodedCommands.add(filename.toLowerCase());
              }
            }
          }
        }
      } catch {
        // Ignore errors
      }
    }

    for (const cmd of commands) {
      const sanitizedName = cmd.name
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');

      if (hardcodedCommands.has(sanitizedName)) {
        continue;
      }

      const filePath = path.join(srcDir, `${cmd.name}.ts`);
      await Bun.write(
        filePath,
        COMMAND_TEMPLATE(sanitizedName, cmd.description, cmd.response),
      );
    }

    console.log(`Generated ${commands.length} custom commands in ${srcDir}`);

    // Clean up any accidental .ts files in dist
    try {
      const distFiles = await readdir(distDir);
      for (const file of distFiles) {
        if (file.endsWith('.ts')) {
          await unlink(path.join(distDir, file));
        }
      }
    } catch {
      // distDir might not exist yet
    }
  } catch (error) {
    console.error('Failed to generate custom commands:', error);
  }
}
