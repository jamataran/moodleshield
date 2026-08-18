/**
 * Reclama como máximo un trabajo y alterna las colas para que una migración de
 * muchos vídeos no deje los PDF esperando indefinidamente. El procesamiento
 * sigue siendo estrictamente secuencial: este helper nunca reclama un segundo
 * job mientras el worker tiene uno activo.
 */
export async function claimNextJob (pipelines, startIndex, claimOptions) {
  if (!Array.isArray(pipelines) || pipelines.length === 0) {
    return { pipeline: null, job: null, nextIndex: 0 }
  }
  const start = Number.isInteger(startIndex) ? startIndex % pipelines.length : 0
  for (let offset = 0; offset < pipelines.length; offset++) {
    const index = (start + offset) % pipelines.length
    const pipeline = pipelines[index]
    const job = await pipeline.queue.claimJob(claimOptions)
    if (job) {
      return { pipeline, job, nextIndex: (index + 1) % pipelines.length }
    }
  }
  return { pipeline: null, job: null, nextIndex: start }
}
