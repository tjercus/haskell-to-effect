module Main where

countTo :: Int -> Int -> IO ()
countTo i n =
  if i > n
    then return ()
    else do
      if i `mod` 2500 == 0 then print i else return ()
      countTo (i + 1) n

sumLines :: Int -> Int -> IO Int
sumLines 0 acc = return acc
sumLines k acc = do
  line <- getLine
  sumLines (k - 1) (acc + length line)

main :: IO ()
main = do
  countTo 1 10000
  total <- sumLines 3 0
  putStrLn ("total length: " ++ show total)
  mapM_ print [1, 2, 3]
