import { TasksModule } from '../TasksModule';
import { generateTask } from './generateTask';
import { insertGeneratedTask } from './insertGeneratedTask';

export async function generateAndInsertTask(
  plugin: TasksModule,
  taskDescription: string
): Promise<void> {
  const generatedTask = await generateTask(plugin, taskDescription);
  await insertGeneratedTask(plugin, generatedTask);
}
